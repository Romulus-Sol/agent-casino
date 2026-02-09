/**
 * Draw a lottery winner using Switchboard VRF
 *
 * Usage: npx ts-node scripts/lottery-draw.ts <lottery_address>
 *
 * Requires lottery to have ended (current slot >= end_slot) and tickets > 0.
 * Creates a Switchboard randomness account, commits, reveals, and draws in one flow.
 */

import { Connection, PublicKey, Transaction, ComputeBudgetProgram, clusterApiUrl, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgentCasino } from "../sdk/src";
import { loadWallet } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import * as sb from "@switchboard-xyz/on-demand";
import * as fs from "fs";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  const lotteryAddress = process.argv[2];
  if (!lotteryAddress) {
    console.error("Usage: npx ts-node scripts/lottery-draw.ts <lottery_address>");
    process.exit(1);
  }

  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const { keypair, address } = loadWallet();
  const casino = new AgentCasino(connection, keypair);

  // Show lottery info
  const info = await casino.getLotteryInfo(lotteryAddress);
  console.log("=== Draw Lottery Winner ===");
  console.log(`Lottery: ${lotteryAddress}`);
  console.log(`Status: ${info.status} | Tickets: ${info.ticketsSold}/${info.maxTickets}`);
  console.log(`Pool: ${info.totalPool} SOL | End Slot: ${info.endSlot}`);
  console.log();

  if (info.status !== "Open") {
    console.error("Lottery is not open (already drawn or cancelled)");
    process.exit(1);
  }

  const currentSlot = await connection.getSlot();
  if (currentSlot < info.endSlot) {
    console.error(`Lottery hasn't ended yet. Current slot: ${currentSlot}, end slot: ${info.endSlot} (${info.endSlot - currentSlot} slots remaining)`);
    process.exit(1);
  }

  console.log("Setting up Switchboard VRF...");

  // Setup Switchboard
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const sbIdl = await anchor.Program.fetchIdl(sb.ON_DEMAND_DEVNET_PID, provider);
  if (!sbIdl) throw new Error("Could not fetch Switchboard IDL");
  const sbProgram = new anchor.Program(sbIdl, provider);

  // Load casino program
  const idlPath = require("path").join(__dirname, "../target/idl/agent_casino.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider) as any;

  const [housePda] = PublicKey.findProgramAddressSync([Buffer.from("house")], PROGRAM_ID);
  const lotteryPda = new PublicKey(lotteryAddress);

  // Step 1: Create randomness account
  console.log("Creating randomness account...");
  const rngKeypair = anchor.web3.Keypair.generate();
  const [rngAccount, createIx] = await sb.Randomness.create(
    sbProgram as any, rngKeypair, sb.ON_DEMAND_DEVNET_QUEUE, keypair.publicKey);
  await provider.sendAndConfirm(new Transaction().add(createIx), [keypair, rngKeypair]);

  // Step 2: Commit randomness
  console.log("Committing randomness...");
  const commitIx = await rngAccount.commitIx(sb.ON_DEMAND_DEVNET_QUEUE, keypair.publicKey);
  await provider.sendAndConfirm(new Transaction().add(commitIx), [keypair]);

  // Step 3: Build draw instruction
  const drawIx = await program.methods.drawLotteryWinner()
    .accounts({
      house: housePda,
      lottery: lotteryPda,
      randomnessAccount: rngAccount.pubkey,
      drawer: keypair.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).instruction();

  // Step 4: Wait for oracle, then reveal+draw in same TX
  console.log("Waiting for oracle to commit...");
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
        .add(drawIx);
      tx = await provider.sendAndConfirm(combinedTx, [keypair]);
      break;
    } catch (e: any) {
      console.log = origLog; console.error = origErr;
      if (i < 11) {
        process.stdout.write(`  Retry ${i + 1}/12...\r`);
      } else {
        throw new Error(`VRF oracle unavailable after 12 retries`);
      }
    }
  }

  // Show result
  const updatedInfo = await casino.getLotteryInfo(lotteryAddress);
  console.log("\nLottery drawn!");
  console.log(`  Winner: Ticket #${updatedInfo.winnerTicket}`);
  console.log(`  Status: ${updatedInfo.status}`);
  console.log(`  TX: ${tx}`);
  console.log();
  console.log(`Claim prize: npx ts-node scripts/lottery-claim.ts ${lotteryAddress} ${updatedInfo.winnerTicket}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
