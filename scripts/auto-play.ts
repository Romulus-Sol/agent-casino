/**
 * Auto-Play Bot — Plays N VRF-backed games across all 4 game types
 *
 * Usage: npx ts-node scripts/auto-play.ts [num_games]
 *   num_games: number of games to play (default: 20)
 *
 * Each game uses Switchboard VRF for provably fair randomness.
 * Game mix: 40% coinflip, 25% dice, 20% limbo, 15% crash
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, ComputeBudgetProgram, clusterApiUrl } from "@solana/web3.js";
import { AgentCasino } from "../sdk/src";
import { loadWallet } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import * as sb from "@switchboard-xyz/on-demand";
import * as fs from "fs";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

// ── Stats tracking ──
interface RunStats {
  gamesPlayed: number;
  wins: number;
  losses: number;
  errors: number;
  totalBet: number;
  totalPayout: number;
  byType: Record<string, { played: number; wins: number; wagered: number; payout: number }>;
}

function initStats(): RunStats {
  return {
    gamesPlayed: 0, wins: 0, losses: 0, errors: 0,
    totalBet: 0, totalPayout: 0,
    byType: {
      coinflip: { played: 0, wins: 0, wagered: 0, payout: 0 },
      dice: { played: 0, wins: 0, wagered: 0, payout: 0 },
      limbo: { played: 0, wins: 0, wagered: 0, payout: 0 },
      crash: { played: 0, wins: 0, wagered: 0, payout: 0 },
    },
  };
}

// ── VRF game player (from demo/full-showcase.ts pattern) ──
async function vrfPlayGame(
  sbProgram: anchor.Program,
  program: anchor.Program,
  provider: anchor.AnchorProvider,
  housePda: PublicKey,
  keypair: anchor.web3.Keypair,
  gameType: "coinflip" | "dice" | "limbo" | "crash",
  amountSol: number,
  param: any,
): Promise<{ won: boolean; payout: number; result: number; tx: string }> {
  // Step 1: Create randomness account
  const rngKeypair = anchor.web3.Keypair.generate();
  const [rngAccount, createIx] = await sb.Randomness.create(
    sbProgram as any, rngKeypair, sb.ON_DEMAND_DEVNET_QUEUE, keypair.publicKey);
  await provider.sendAndConfirm(new Transaction().add(createIx), [keypair, rngKeypair]);

  // Step 2: Send VRF request
  const houseAccount = await program.account.house.fetch(housePda);
  const amount = new anchor.BN(amountSol * LAMPORTS_PER_SOL);
  let seedPrefix: string;
  let requestMethod: string;
  let settleMethod: string;
  let requestArgs: any[];

  switch (gameType) {
    case "coinflip":
      seedPrefix = "vrf_request";
      requestMethod = "vrfCoinFlipRequest";
      settleMethod = "vrfCoinFlipSettle";
      requestArgs = [amount, param === "heads" ? 0 : 1];
      break;
    case "dice":
      seedPrefix = "vrf_dice";
      requestMethod = "vrfDiceRollRequest";
      settleMethod = "vrfDiceRollSettle";
      requestArgs = [amount, param];
      break;
    case "limbo":
      seedPrefix = "vrf_limbo";
      requestMethod = "vrfLimboRequest";
      settleMethod = "vrfLimboSettle";
      requestArgs = [amount, Math.floor(param * 100)];
      break;
    case "crash":
      seedPrefix = "vrf_crash";
      requestMethod = "vrfCrashRequest";
      settleMethod = "vrfCrashSettle";
      requestArgs = [amount, Math.floor(param * 100)];
      break;
  }

  const [vrfRequestPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(seedPrefix), keypair.publicKey.toBuffer(),
     (houseAccount as any).totalGames.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID);

  await (program.methods as any)[requestMethod](...requestArgs)
    .accounts({
      house: housePda,
      vrfRequest: vrfRequestPda,
      randomnessAccount: rngAccount.pubkey,
      player: keypair.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).rpc();

  // Step 3: Commit randomness
  const commitIx = await rngAccount.commitIx(sb.ON_DEMAND_DEVNET_QUEUE, keypair.publicKey);
  await provider.sendAndConfirm(new Transaction().add(commitIx), [keypair]);

  // Step 4: Build settle instruction
  const [agentStatsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), keypair.publicKey.toBuffer()], PROGRAM_ID);

  const settleIx = await (program.methods as any)[settleMethod]()
    .accounts({
      house: housePda,
      vrfRequest: vrfRequestPda,
      agentStats: agentStatsPda,
      randomnessAccount: rngAccount.pubkey,
      player: keypair.publicKey,
      settler: keypair.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).instruction();

  // Step 5: Wait for oracle, then reveal+settle in same TX
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
      if (i === 11) throw new Error(`VRF oracle unavailable after 12 retries`);
    }
  }

  // Step 6: Read result
  const settled = await program.account.vrfRequest.fetch(vrfRequestPda);
  const payout = (settled as any).payout.toNumber() / LAMPORTS_PER_SOL;
  return { won: payout > 0, payout, result: (settled as any).result, tx };
}

// ── Game selection ──
function pickGame(): { type: "coinflip" | "dice" | "limbo" | "crash"; param: any; label: string } {
  const r = Math.random();
  if (r < 0.40) {
    const choice = Math.random() < 0.5 ? "heads" : "tails";
    return { type: "coinflip", param: choice, label: `Coin Flip (${choice})` };
  } else if (r < 0.65) {
    const target = Math.floor(Math.random() * 3) + 1; // 1-3
    return { type: "dice", param: target, label: `Dice Roll (target <=${target})` };
  } else if (r < 0.85) {
    const mult = +(1.5 + Math.random() * 1.5).toFixed(2); // 1.50-3.00
    return { type: "limbo", param: mult, label: `Limbo (>=${mult}x)` };
  } else {
    const mult = +(1.2 + Math.random() * 0.8).toFixed(2); // 1.20-2.00
    return { type: "crash", param: mult, label: `Crash (cashout ${mult}x)` };
  }
}

async function main() {
  const numGames = parseInt(process.argv[2] || "20", 10);
  const betSize = 0.001; // SOL per game

  console.log("=== Agent Casino Auto-Play Bot ===");
  console.log(`Games: ${numGames} | Bet: ${betSize} SOL each`);
  console.log(`Game mix: 40% coinflip, 25% dice, 20% limbo, 15% crash\n`);

  // Setup
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const { keypair, address } = loadWallet();
  const casino = new AgentCasino(connection, keypair);
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // Load programs
  const sbIdl = await anchor.Program.fetchIdl(sb.ON_DEMAND_DEVNET_PID, provider);
  if (!sbIdl) throw new Error("Could not fetch Switchboard IDL");
  const sbProgram = new anchor.Program(sbIdl, provider);

  const idlPath = require("path").join(__dirname, "../target/idl/agent_casino.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider) as any;

  const [housePda] = PublicKey.findProgramAddressSync([Buffer.from("house")], PROGRAM_ID);

  // Pre-game stats
  const balance = await connection.getBalance(keypair.publicKey);
  const house = await casino.getHouseStats();
  console.log(`Wallet: ${address}`);
  console.log(`Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log(`House pool: ${house.pool.toFixed(4)} SOL | Total games: ${house.totalGames}\n`);

  const stats = initStats();
  const startBalance = balance;

  // Play games
  for (let i = 0; i < numGames; i++) {
    const game = pickGame();
    const gameNum = `[${i + 1}/${numGames}]`;
    process.stdout.write(`${gameNum} ${game.label} @ ${betSize} SOL ... `);

    try {
      const result = await vrfPlayGame(
        sbProgram, program, provider, housePda, keypair,
        game.type, betSize, game.param);

      stats.gamesPlayed++;
      stats.totalBet += betSize;
      stats.byType[game.type].played++;
      stats.byType[game.type].wagered += betSize;

      if (result.won) {
        stats.wins++;
        stats.totalPayout += result.payout;
        stats.byType[game.type].wins++;
        stats.byType[game.type].payout += result.payout;
        console.log(`WIN +${result.payout.toFixed(4)} SOL  (tx: ${result.tx.slice(0, 12)}...)`);
      } else {
        stats.losses++;
        console.log(`LOSS -${betSize} SOL  (tx: ${result.tx.slice(0, 12)}...)`);
      }
    } catch (err: any) {
      stats.errors++;
      console.log(`ERROR: ${err.message.slice(0, 60)}`);
    }

    // Brief pause between games
    if (i < numGames - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Final stats
  const endBalance = await connection.getBalance(keypair.publicKey);
  const netChange = (endBalance - startBalance) / LAMPORTS_PER_SOL;
  const updatedHouse = await casino.getHouseStats();

  console.log("\n=== Results ===");
  console.log(`Games: ${stats.gamesPlayed} played, ${stats.errors} errors`);
  console.log(`Record: ${stats.wins}W / ${stats.losses}L (${stats.gamesPlayed > 0 ? (stats.wins / stats.gamesPlayed * 100).toFixed(1) : 0}%)`);
  console.log(`Wagered: ${stats.totalBet.toFixed(4)} SOL | Paid out: ${stats.totalPayout.toFixed(4)} SOL`);
  console.log(`Net P&L: ${netChange >= 0 ? "+" : ""}${netChange.toFixed(4)} SOL`);

  console.log("\n--- By Game Type ---");
  for (const [type, data] of Object.entries(stats.byType)) {
    if (data.played === 0) continue;
    const winRate = data.played > 0 ? (data.wins / data.played * 100).toFixed(0) : "0";
    const pnl = data.payout - data.wagered;
    console.log(`  ${type.padEnd(10)} ${data.played} games, ${data.wins}W/${data.played - data.wins}L (${winRate}%), P&L: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL`);
  }

  console.log(`\nHouse total games: ${house.totalGames} -> ${updatedHouse.totalGames}`);
  console.log(`House pool: ${house.pool.toFixed(4)} -> ${updatedHouse.pool.toFixed(4)} SOL`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
