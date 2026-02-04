import { loadWallet, isAgentWalletConfigured } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  const memoryAddress = process.argv[2];
  const rating = parseInt(process.argv[3]);

  if (!memoryAddress || !rating) {
    console.log("Usage: npx ts-node scripts/memory-rate.ts <MEMORY_ADDRESS> <RATING>");
    console.log("\nRating scale:");
    console.log("  1-2: Bad (depositor loses stake)");
    console.log("  3: Neutral (no change)");
    console.log("  4-5: Good (depositor keeps stake)");
    process.exit(1);
  }

  if (rating < 1 || rating > 5) {
    console.error("Rating must be 1-5");
    process.exit(1);
  }

  console.log("=== RATE MEMORY ===\n");
  console.log("Memory Address:", memoryAddress);
  console.log("Rating:", rating, rating <= 2 ? "(Bad)" : rating === 3 ? "(Neutral)" : "(Good)");

  // Load wallet
  // Load wallet (AgentWallet aware)
  const { keypair: walletKeypair } = loadWallet();
  console.log("Rater:", walletKeypair.publicKey.toString());

  // Connect to devnet
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // Load IDL
  const idlPath = path.join(__dirname, "../target/idl/agent_casino.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider) as any;

  // Derive PDAs
  const [memoryPoolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("memory_pool")],
    PROGRAM_ID
  );

  const memoryPubkey = new PublicKey(memoryAddress);

  const [pullRecordPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mem_pull"), memoryPubkey.toBuffer(), walletKeypair.publicKey.toBuffer()],
    PROGRAM_ID
  );

  try {
    const tx = await program.methods
      .rateMemory(rating)
      .accounts({
        memoryPool: memoryPoolPda,
        memory: memoryPubkey,
        pullRecord: pullRecordPda,
        rater: walletKeypair.publicKey,
      })
      .rpc();

    console.log("\nRating submitted!");
    console.log("Transaction:", tx);

    // Fetch updated memory stats
    const memory = await program.account.memory.fetch(memoryPubkey);
    const avgRating = memory.ratingCount.toNumber() > 0
      ? (memory.totalRating.toNumber() / memory.ratingCount.toNumber()).toFixed(2)
      : "N/A";

    console.log("\n=== MEMORY STATS ===");
    console.log("Total Ratings:", memory.ratingCount.toString());
    console.log("Average Rating:", avgRating);
    console.log("Depositor Stake Remaining:", memory.stake.toNumber() / 1e9, "SOL");

    if (rating <= 2) {
      console.log("\nBad rating - depositor's stake was forfeited to the pool.");
    }

  } catch (e: any) {
    console.error("\nError rating memory:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
