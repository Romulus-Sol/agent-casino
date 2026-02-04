import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  const memoryAddress = process.argv[2];

  if (!memoryAddress) {
    console.log("Usage: npx ts-node scripts/memory-pull.ts <MEMORY_ADDRESS>");
    console.log("\nTo find available memories, run:");
    console.log("  npx ts-node scripts/memory-view-pool.ts");
    process.exit(1);
  }

  console.log("=== PULL MEMORY ===\n");
  console.log("Memory Address:", memoryAddress);

  // Load wallet
  const walletPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const walletKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  console.log("Puller:", walletKeypair.publicKey.toString());

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
  const [housePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("house")],
    PROGRAM_ID
  );

  const [memoryPoolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("memory_pool")],
    PROGRAM_ID
  );

  const memoryPubkey = new PublicKey(memoryAddress);

  // Fetch memory to get depositor
  const memoryAccount = await program.account.memory.fetch(memoryPubkey);
  const depositor = memoryAccount.depositor;

  // Derive pull record PDA
  const [pullRecordPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mem_pull"), memoryPubkey.toBuffer(), walletKeypair.publicKey.toBuffer()],
    PROGRAM_ID
  );

  // Generate client seed
  const clientSeed = randomBytes(32);

  // Fetch pool for pricing
  const poolAccount = await program.account.memoryPool.fetch(memoryPoolPda);
  console.log("\nPull Price:", poolAccount.pullPrice.toNumber() / LAMPORTS_PER_SOL, "SOL");

  try {
    const tx = await program.methods
      .pullMemory([...clientSeed])
      .accounts({
        house: housePda,
        memoryPool: memoryPoolPda,
        memory: memoryPubkey,
        depositor: depositor,
        pullRecord: pullRecordPda,
        puller: walletKeypair.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("\nMemory pulled!");
    console.log("Transaction:", tx);

    // Fetch and display the memory content
    const memory = await program.account.memory.fetch(memoryPubkey);
    const contentLength = memory.contentLength;
    const content = Buffer.from(memory.content.slice(0, contentLength)).toString("utf8");

    const categoryNames = ["Strategy", "Technical", "Alpha", "Random"];
    const rarityNames = ["Common", "Rare", "Legendary"];

    console.log("\n=== MEMORY CONTENT ===");
    console.log("Category:", categoryNames[Object.keys(memory.category)[0] === "strategy" ? 0 :
                            Object.keys(memory.category)[0] === "technical" ? 1 :
                            Object.keys(memory.category)[0] === "alpha" ? 2 : 3]);
    console.log("Rarity:", rarityNames[Object.keys(memory.rarity)[0] === "common" ? 0 :
                          Object.keys(memory.rarity)[0] === "rare" ? 1 : 2]);
    console.log("Depositor:", memory.depositor.toString());
    console.log("Times Pulled:", memory.timesPulled.toString());
    console.log("\nContent:");
    console.log("---");
    console.log(content);
    console.log("---");
    console.log("\nRate this memory (1-5):");
    console.log(`  npx ts-node scripts/memory-rate.ts ${memoryAddress} <RATING>`);

  } catch (e: any) {
    console.error("\nError pulling memory:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
