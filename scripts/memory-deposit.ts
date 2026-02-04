import { loadWallet, isAgentWalletConfigured } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

// Category: strategy, technical, alpha, random
// Rarity: common, rare, legendary
const CATEGORIES: Record<string, any> = {
  strategy: { strategy: {} },
  technical: { technical: {} },
  alpha: { alpha: {} },
  random: { random: {} },
};

const RARITIES: Record<string, any> = {
  common: { common: {} },
  rare: { rare: {} },
  legendary: { legendary: {} },
};

async function main() {
  const content = process.argv[2];
  const category = (process.argv[3] || "random").toLowerCase();
  const rarity = (process.argv[4] || "common").toLowerCase();

  if (!content) {
    console.log("Usage: npx ts-node scripts/memory-deposit.ts <CONTENT> [CATEGORY] [RARITY]");
    console.log("\nCategories: strategy, technical, alpha, random");
    console.log("Rarities: common (70%), rare (25%), legendary (5%)");
    console.log("\nExample:");
    console.log('  npx ts-node scripts/memory-deposit.ts "Always use stop losses" strategy rare');
    process.exit(1);
  }

  if (!CATEGORIES[category]) {
    console.error("Invalid category. Use: strategy, technical, alpha, random");
    process.exit(1);
  }

  if (!RARITIES[rarity]) {
    console.error("Invalid rarity. Use: common, rare, legendary");
    process.exit(1);
  }

  console.log("=== DEPOSIT MEMORY ===\n");
  console.log("Content:", content.substring(0, 100) + (content.length > 100 ? "..." : ""));
  console.log("Category:", category);
  console.log("Rarity:", rarity);
  console.log("Stake: 0.01 SOL\n");

  // Load wallet
  // Load wallet (AgentWallet aware)
  const { keypair: walletKeypair } = loadWallet();
  console.log("Depositor:", walletKeypair.publicKey.toString());

  // Connect to devnet
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // Load IDL
  const idlPath = path.join(__dirname, "../target/idl/agent_casino.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider) as any;

  // Derive memory pool PDA
  const [memoryPoolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("memory_pool")],
    PROGRAM_ID
  );

  // Fetch pool to get memory index
  const poolAccount = await program.account.memoryPool.fetch(memoryPoolPda);
  const memoryIndex = poolAccount.totalMemories;

  // Derive memory PDA
  const [memoryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("memory"), memoryPoolPda.toBuffer(), memoryIndex.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  );

  console.log("Memory PDA:", memoryPda.toString());

  try {
    const tx = await program.methods
      .depositMemory(content, CATEGORIES[category], RARITIES[rarity])
      .accounts({
        memoryPool: memoryPoolPda,
        memory: memoryPda,
        depositor: walletKeypair.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("\nMemory deposited!");
    console.log("Transaction:", tx);
    console.log("\n=== MEMORY INFO ===");
    console.log("Memory Address:", memoryPda.toString());
    console.log("Index:", memoryIndex.toString());
    console.log("\nOthers can pull this memory for:", poolAccount.pullPrice.toNumber() / LAMPORTS_PER_SOL, "SOL");

  } catch (e: any) {
    console.error("\nError depositing memory:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
