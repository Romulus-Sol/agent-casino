/**
 * Tournament Mode — Multi-round elimination tournament using VRF games
 *
 * Usage: npx ts-node scripts/tournament.ts [players] [rounds] [bet_sol]
 *   players: Number of virtual players (default: 8)
 *   rounds: Number of rounds (default: 3)
 *   bet_sol: Bet size per game in SOL (default: 0.001)
 *
 * Each round, all active players play a VRF coin flip.
 * Winners advance, losers are eliminated. Last player standing wins.
 *
 * Note: Single-wallet tournament (demo). All games are played from our wallet
 * with different virtual player IDs. Real multi-agent tournaments would use PvP.
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, ComputeBudgetProgram, clusterApiUrl } from "@solana/web3.js";
import { AgentCasino } from "../sdk/src";
import { loadWallet } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import * as sb from "@switchboard-xyz/on-demand";
import * as fs from "fs";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

interface Player {
  id: number;
  name: string;
  score: number;
  wins: number;
  losses: number;
  active: boolean;
}

// VRF game helper (same pattern as auto-play and demo)
async function vrfCoinFlip(
  sbProgram: anchor.Program,
  program: anchor.Program,
  provider: anchor.AnchorProvider,
  housePda: PublicKey,
  keypair: anchor.web3.Keypair,
  amountSol: number,
  choice: number,
): Promise<{ won: boolean; payout: number; tx: string }> {
  const rngKeypair = anchor.web3.Keypair.generate();
  const [rngAccount, createIx] = await sb.Randomness.create(
    sbProgram as any, rngKeypair, sb.ON_DEMAND_DEVNET_QUEUE, keypair.publicKey);
  await provider.sendAndConfirm(new Transaction().add(createIx), [keypair, rngKeypair]);

  const houseAccount = await program.account.house.fetch(housePda);
  const amount = new anchor.BN(amountSol * LAMPORTS_PER_SOL);

  const [vrfRequestPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vrf_request"), keypair.publicKey.toBuffer(),
     (houseAccount as any).totalGames.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID);

  await (program.methods as any).vrfCoinFlipRequest(amount, choice)
    .accounts({
      house: housePda,
      vrfRequest: vrfRequestPda,
      randomnessAccount: rngAccount.pubkey,
      player: keypair.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).rpc();

  const commitIx = await rngAccount.commitIx(sb.ON_DEMAND_DEVNET_QUEUE, keypair.publicKey);
  await provider.sendAndConfirm(new Transaction().add(commitIx), [keypair]);

  const [agentStatsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), keypair.publicKey.toBuffer()], PROGRAM_ID);

  const settleIx = await (program.methods as any).vrfCoinFlipSettle()
    .accounts({
      house: housePda,
      vrfRequest: vrfRequestPda,
      agentStats: agentStatsPda,
      randomnessAccount: rngAccount.pubkey,
      player: keypair.publicKey,
      settler: keypair.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).instruction();

  const origLog = console.log;
  const origErr = console.error;
  let tx = "";
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 2500));
    try {
      console.log = () => {}; console.error = () => {};
      const revealIx = await rngAccount.revealIx(keypair.publicKey);
      console.log = origLog; console.error = origErr;
      const combinedTx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 75000 }))
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }))
        .add(revealIx)
        .add(settleIx);
      tx = await provider.sendAndConfirm(combinedTx, [keypair]);
      break;
    } catch (e: any) {
      console.log = origLog; console.error = origErr;
      if (i === 11) throw new Error("VRF oracle unavailable");
    }
  }

  const settled = await program.account.vrfRequest.fetch(vrfRequestPda);
  const payout = (settled as any).payout.toNumber() / LAMPORTS_PER_SOL;
  return { won: payout > 0, payout, tx };
}

async function main() {
  const numPlayers = parseInt(process.argv[2] || "8", 10);
  const numRounds = parseInt(process.argv[3] || "3", 10);
  const betSol = parseFloat(process.argv[4] || "0.001");

  const agentNames = [
    "Alpha", "Bravo", "Charlie", "Delta",
    "Echo", "Foxtrot", "Golf", "Hotel",
    "India", "Juliet", "Kilo", "Lima",
    "Mike", "November", "Oscar", "Papa",
  ];

  console.log("=== Agent Casino Tournament ===");
  console.log(`Players: ${numPlayers} | Rounds: ${numRounds} | Bet: ${betSol} SOL/game`);
  console.log(`Game: VRF Coin Flip | Elimination: bottom half each round\n`);

  // Setup
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const { keypair, address } = loadWallet();
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const sbIdl = await anchor.Program.fetchIdl(sb.ON_DEMAND_DEVNET_PID, provider);
  if (!sbIdl) throw new Error("Could not fetch Switchboard IDL");
  const sbProgram = new anchor.Program(sbIdl, provider);

  const idlPath = require("path").join(__dirname, "../target/idl/agent_casino.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider) as any;

  const [housePda] = PublicKey.findProgramAddressSync([Buffer.from("house")], PROGRAM_ID);

  // Initialize players
  const players: Player[] = [];
  for (let i = 0; i < numPlayers; i++) {
    players.push({
      id: i,
      name: agentNames[i % agentNames.length],
      score: 0,
      wins: 0,
      losses: 0,
      active: true,
    });
  }

  console.log("Registered players:");
  players.forEach(p => console.log(`  [${p.id}] ${p.name}`));
  console.log();

  // Run tournament rounds
  for (let round = 1; round <= numRounds; round++) {
    const activePlayers = players.filter(p => p.active);
    if (activePlayers.length <= 1) break;

    console.log(`${"=".repeat(50)}`);
    console.log(`  ROUND ${round}/${numRounds} — ${activePlayers.length} players remaining`);
    console.log(`${"=".repeat(50)}\n`);

    // Each active player plays one VRF coin flip
    for (const player of activePlayers) {
      const choice = Math.random() < 0.5 ? 0 : 1; // random heads/tails
      const choiceStr = choice === 0 ? "Heads" : "Tails";
      process.stdout.write(`  ${player.name.padEnd(10)} picks ${choiceStr}... `);

      try {
        const result = await vrfCoinFlip(
          sbProgram, program, provider, housePda, keypair,
          betSol, choice);

        if (result.won) {
          player.wins++;
          player.score += result.payout;
          console.log(`WIN  +${result.payout.toFixed(4)} SOL  (score: ${player.score.toFixed(4)})`);
        } else {
          player.losses++;
          player.score -= betSol;
          console.log(`LOSS -${betSol} SOL  (score: ${player.score.toFixed(4)})`);
        }
      } catch (err: any) {
        player.losses++;
        player.score -= betSol;
        console.log(`ERROR (counted as loss): ${err.message.slice(0, 40)}`);
      }

      // Brief pause
      await new Promise(r => setTimeout(r, 500));
    }

    // Eliminate bottom half
    const sorted = activePlayers.sort((a, b) => b.score - a.score);
    const cutoff = Math.ceil(sorted.length / 2);

    console.log(`\n  Standings after Round ${round}:`);
    sorted.forEach((p, i) => {
      const status = i < cutoff ? "ADVANCE" : "ELIMINATED";
      const icon = i < cutoff ? "  " : "X ";
      console.log(`  ${icon}${(i + 1).toString().padStart(2)}. ${p.name.padEnd(10)} ${p.score >= 0 ? "+" : ""}${p.score.toFixed(4)} SOL  (${p.wins}W/${p.losses}L)  ${i >= cutoff ? "<-- OUT" : ""}`);
      if (i >= cutoff) p.active = false;
    });
    console.log();
  }

  // Final results
  const winner = players.filter(p => p.active).sort((a, b) => b.score - a.score)[0];
  const allSorted = players.sort((a, b) => b.score - a.score);

  console.log("=".repeat(50));
  console.log("  TOURNAMENT COMPLETE");
  console.log("=".repeat(50));
  console.log();

  if (winner) {
    console.log(`  WINNER: ${winner.name} (${winner.score >= 0 ? "+" : ""}${winner.score.toFixed(4)} SOL, ${winner.wins}W/${winner.losses}L)`);
  }

  console.log(`\n  Final Rankings:`);
  allSorted.forEach((p, i) => {
    const medal = i === 0 ? "1st" : i === 1 ? "2nd" : i === 2 ? "3rd" : `${i + 1}th`;
    console.log(`    ${medal.padEnd(4)} ${p.name.padEnd(10)} ${p.score >= 0 ? "+" : ""}${p.score.toFixed(4)} SOL  ${p.wins}W/${p.losses}L`);
  });

  console.log(`\n  Total games played: ${players.reduce((sum, p) => sum + p.wins + p.losses, 0)}`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
