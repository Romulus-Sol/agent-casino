import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  console.log("=== MY DEPOSITED MEMORIES ===\n");

  // Load wallet
  const walletPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const walletKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  console.log("Depositor:", walletKeypair.publicKey.toString(), "\n");

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
    const totalMemories = pool.totalMemories.toNumber();

    let myMemories: any[] = [];
    let totalEarned = 0;
    let totalStake = 0;

    for (let i = 0; i < totalMemories; i++) {
      try {
        const [memoryPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("memory"), memoryPoolPda.toBuffer(), new anchor.BN(i).toArrayLike(Buffer, "le", 8)],
          PROGRAM_ID
        );

        const memory = await program.account.memory.fetch(memoryPda);

        if (memory.depositor.equals(walletKeypair.publicKey)) {
          const contentLength = memory.contentLength;
          const content = Buffer.from(memory.content.slice(0, contentLength)).toString("utf8");
          const categoryKey = Object.keys(memory.category)[0];
          const rarityKey = Object.keys(memory.rarity)[0];

          // Calculate earnings (pulls * depositor share)
          const pullPrice = pool.pullPrice.toNumber();
          const houseEdge = pool.houseEdgeBps;
          const depositorShare = pullPrice * (10000 - houseEdge) / 10000;
          const earned = memory.timesPulled.toNumber() * depositorShare / LAMPORTS_PER_SOL;
          totalEarned += earned;
          totalStake += memory.stake.toNumber();

          myMemories.push({
            index: i,
            address: memoryPda.toString(),
            content,
            category: categoryKey,
            rarity: rarityKey,
            active: memory.active,
            timesPulled: memory.timesPulled.toNumber(),
            totalRating: memory.totalRating.toNumber(),
            ratingCount: memory.ratingCount.toNumber(),
            stake: memory.stake.toNumber() / LAMPORTS_PER_SOL,
            earned,
          });
        }
      } catch (e) {
        // Skip if memory doesn't exist
      }
    }

    if (myMemories.length === 0) {
      console.log("No memories deposited yet.");
      console.log("\nTo deposit a memory:");
      console.log('  npx ts-node scripts/memory-deposit.ts "Your knowledge" strategy common');
      return;
    }

    console.log(`Found ${myMemories.length} memories:\n`);

    for (const mem of myMemories) {
      const avgRating = mem.ratingCount > 0
        ? (mem.totalRating / mem.ratingCount).toFixed(1)
        : "N/A";

      console.log(`[${mem.index}] ${mem.address}`);
      console.log(`    Category: ${mem.category.charAt(0).toUpperCase() + mem.category.slice(1)}`);
      console.log(`    Rarity: ${mem.rarity.charAt(0).toUpperCase() + mem.rarity.slice(1)}`);
      console.log(`    Active: ${mem.active ? "Yes" : "No"}`);
      console.log(`    Times Pulled: ${mem.timesPulled}`);
      console.log(`    Avg Rating: ${avgRating}/5 (${mem.ratingCount} ratings)`);
      console.log(`    Stake Remaining: ${mem.stake} SOL`);
      console.log(`    Total Earned: ${mem.earned.toFixed(4)} SOL`);
      console.log(`    Preview: ${mem.content.substring(0, 60)}${mem.content.length > 60 ? "..." : ""}`);
      console.log();
    }

    console.log("=== SUMMARY ===");
    console.log("Total Memories:", myMemories.length);
    console.log("Total Stake Remaining:", (totalStake / LAMPORTS_PER_SOL).toFixed(4), "SOL");
    console.log("Total Earned:", totalEarned.toFixed(4), "SOL");

    const activeUnpulled = myMemories.filter(m => m.active && m.timesPulled === 0);
    if (activeUnpulled.length > 0) {
      console.log("\nMemories you can withdraw (unpulled):", activeUnpulled.length);
      console.log("To withdraw:");
      console.log("  npx ts-node scripts/memory-withdraw.ts <MEMORY_ADDRESS>");
    }

  } catch (e: any) {
    if (e.message.includes("Account does not exist")) {
      console.log("Memory pool not initialized.");
    } else {
      console.error("Error:", e.message);
    }
  }
}

main().catch(console.error);
