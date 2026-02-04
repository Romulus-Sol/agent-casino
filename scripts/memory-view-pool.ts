import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  const showMemories = process.argv[2] === "--memories" || process.argv[2] === "-m";
  const limit = parseInt(process.argv[3]) || 10;

  console.log("=== MEMORY POOL STATS ===\n");

  // Load wallet (for provider, not signing)
  const walletPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const walletKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );

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

  try {
    const pool = await program.account.memoryPool.fetch(memoryPoolPda);

    console.log("Pool Address:", memoryPoolPda.toString());
    console.log("Authority:", pool.authority.toString());
    console.log("\n--- Pricing ---");
    console.log("Pull Price:", pool.pullPrice.toNumber() / LAMPORTS_PER_SOL, "SOL");
    console.log("Stake Amount:", pool.stakeAmount.toNumber() / LAMPORTS_PER_SOL, "SOL");
    console.log("House Edge:", pool.houseEdgeBps / 100, "%");
    console.log("\n--- Stats ---");
    console.log("Total Memories:", pool.totalMemories.toString());
    console.log("Total Pulls:", pool.totalPulls.toString());
    console.log("Pool Balance:", pool.poolBalance.toNumber() / LAMPORTS_PER_SOL, "SOL");

    if (showMemories && pool.totalMemories.toNumber() > 0) {
      console.log("\n=== RECENT MEMORIES ===\n");

      const totalMemories = pool.totalMemories.toNumber();
      const startIdx = Math.max(0, totalMemories - limit);

      const categoryNames = ["Strategy", "Technical", "Alpha", "Random"];
      const rarityNames = ["Common", "Rare", "Legendary"];

      for (let i = totalMemories - 1; i >= startIdx; i--) {
        try {
          const [memoryPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("memory"), memoryPoolPda.toBuffer(), new anchor.BN(i).toArrayLike(Buffer, "le", 8)],
            PROGRAM_ID
          );

          const memory = await program.account.memory.fetch(memoryPda);
          const contentLength = memory.contentLength;
          const content = Buffer.from(memory.content.slice(0, contentLength)).toString("utf8");

          const categoryKey = Object.keys(memory.category)[0];
          const rarityKey = Object.keys(memory.rarity)[0];

          console.log(`[${i}] ${memoryPda.toString()}`);
          console.log(`    Category: ${categoryKey.charAt(0).toUpperCase() + categoryKey.slice(1)}`);
          console.log(`    Rarity: ${rarityKey.charAt(0).toUpperCase() + rarityKey.slice(1)}`);
          console.log(`    Active: ${memory.active ? "Yes" : "No"}`);
          console.log(`    Times Pulled: ${memory.timesPulled.toString()}`);
          if (memory.ratingCount.toNumber() > 0) {
            const avgRating = (memory.totalRating.toNumber() / memory.ratingCount.toNumber()).toFixed(1);
            console.log(`    Avg Rating: ${avgRating}/5 (${memory.ratingCount.toString()} ratings)`);
          }
          console.log(`    Preview: ${content.substring(0, 60)}${content.length > 60 ? "..." : ""}`);
          console.log();
        } catch (e) {
          // Skip if memory doesn't exist
        }
      }

      console.log("To pull a memory:");
      console.log("  npx ts-node scripts/memory-pull.ts <MEMORY_ADDRESS>");
    } else if (!showMemories && pool.totalMemories.toNumber() > 0) {
      console.log("\nTo see memories, run:");
      console.log("  npx ts-node scripts/memory-view-pool.ts --memories [limit]");
    }

  } catch (e: any) {
    if (e.message.includes("Account does not exist")) {
      console.log("Memory pool not initialized.");
      console.log("\nTo create a memory pool:");
      console.log("  npx ts-node scripts/memory-create-pool.ts [pull_price_sol] [house_edge_bps]");
    } else {
      console.error("Error:", e.message);
    }
  }
}

main().catch(console.error);
