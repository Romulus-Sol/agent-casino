/**
 * Test: manual commit → reveal+settle in same TX
 */
import { Connection, PublicKey, clusterApiUrl, Transaction, LAMPORTS_PER_SOL, ComputeBudgetProgram } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import * as sb from "@switchboard-xyz/on-demand";
import { AgentCasino } from "../sdk/src";
import { loadWallet } from "../scripts/utils/wallet";

const { keypair } = loadWallet();
const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const sbIdl = await anchor.Program.fetchIdl(sb.ON_DEMAND_DEVNET_PID, provider);
  const sbProgram = new anchor.Program(sbIdl!, provider);
  const casino = new AgentCasino(connection, keypair);
  await casino.loadProgram();
  const program = (casino as any).program;
  const housePda = (casino as any).housePda;

  // Step 1: Create randomness account (no commit)
  console.log("Step 1: Create randomness account...");
  const rngKeypair = anchor.web3.Keypair.generate();
  const [rngAccount, createIx] = await sb.Randomness.create(
    sbProgram as any, rngKeypair, sb.ON_DEMAND_DEVNET_QUEUE, keypair.publicKey);
  await provider.sendAndConfirm(new Transaction().add(createIx), [keypair, rngKeypair]);
  console.log("  Created:", rngAccount.pubkey.toString());

  // Step 2: VRF request
  console.log("Step 2: VRF coin flip request...");
  const houseAccount = await program.account.house.fetch(housePda);
  const amount = new anchor.BN(0.001 * LAMPORTS_PER_SOL);
  const [vrfRequestPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vrf_request"), keypair.publicKey.toBuffer(),
     houseAccount.totalGames.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID);
  await program.methods.vrfCoinFlipRequest(amount, 0)
    .accounts({
      house: housePda, vrfRequest: vrfRequestPda,
      randomnessAccount: rngAccount.pubkey,
      player: keypair.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).rpc();
  console.log("  Request:", vrfRequestPda.toString());

  // Step 3: Commit randomness
  console.log("Step 3: Commit...");
  const commitIx = await rngAccount.commitIx(sb.ON_DEMAND_DEVNET_QUEUE, keypair.publicKey);
  await provider.sendAndConfirm(new Transaction().add(commitIx), [keypair]);
  console.log("  Committed");

  // Step 4: Wait for oracle, get revealIx, combine with settleIx in same TX
  console.log("Step 4: Waiting for oracle + reveal+settle...");
  const [agentStatsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), keypair.publicKey.toBuffer()], PROGRAM_ID);
  const settleIx = await program.methods.vrfCoinFlipSettle()
    .accounts({
      house: housePda, vrfRequest: vrfRequestPda,
      agentStats: agentStatsPda,
      randomnessAccount: rngAccount.pubkey,
      player: keypair.publicKey,
      settler: keypair.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).instruction();

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const revealIx = await rngAccount.revealIx(keypair.publicKey);
      // Put reveal + settle in same TX (same slot!)
      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 75000 }))
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }))
        .add(revealIx)
        .add(settleIx);
      const sig = await provider.sendAndConfirm(tx, [keypair]);
      console.log("  Reveal+Settle TX:", sig.slice(0, 30) + "...");
      break;
    } catch (e: any) {
      const msg = e.message?.slice(0, 80) || "unknown error";
      console.log(`  Attempt ${i+1}: ${msg}`);
    }
  }

  // Step 5: Check result
  const settled = await program.account.vrfRequest.fetch(vrfRequestPda);
  const payout = settled.payout.toNumber() / LAMPORTS_PER_SOL;
  console.log("Result:", payout > 0 ? "WON" : "LOST", "Payout:", payout);
}

main().catch(e => { console.error("Error:", e.message?.slice(0, 200)); process.exit(1); });
