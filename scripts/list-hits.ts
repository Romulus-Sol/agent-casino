import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { AgentCasino } from "../target/types/agent_casino";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

async function main() {
  // Parse args
  const args = process.argv.slice(2);
  const statusFilter = args[0] || "all"; // "open", "claimed", "completed", "all"

  // Load wallet
  const keyPath = path.join(process.env.HOME || "", ".config/solana/id.json");
  const rawKey = JSON.parse(fs.readFileSync(keyPath, "utf-8"));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(rawKey));

  // Connect to devnet
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");

  // Create provider
  const provider = new AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    { commitment: "confirmed" }
  );

  // Load program
  const idl = JSON.parse(fs.readFileSync("./target/idl/agent_casino.json", "utf-8"));
  const programId = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");
  const program = new Program(idl, provider) as Program<AgentCasino>;

  // Derive hit pool PDA
  const [hitPoolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("hit_pool")],
    programId
  );

  // Get pool stats
  const hitPool = await program.account.hitPool.fetch(hitPoolPda);
  console.log("=== HITMAN MARKET ===\n");
  console.log("Pool Stats:");
  console.log("  Total Hits Posted:", hitPool.totalHits.toString());
  console.log("  Total Completed:", hitPool.totalCompleted.toString());
  console.log("  Total Bounties Paid:", hitPool.totalBountiesPaid.toNumber() / LAMPORTS_PER_SOL, "SOL");
  console.log("  House Edge:", hitPool.houseEdgeBps / 100, "%");
  console.log("\n--- Open Hits ---\n");

  // Fetch all hits
  const totalHits = hitPool.totalHits.toNumber();
  const hits = [];

  for (let i = 0; i < totalHits; i++) {
    const hitIndexBuffer = Buffer.alloc(8);
    hitIndexBuffer.writeBigUInt64LE(BigInt(i));
    const [hitPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("hit"), hitPoolPda.toBuffer(), hitIndexBuffer],
      programId
    );

    try {
      const hit = await program.account.hit.fetch(hitPda);
      const status = Object.keys(hit.status)[0];

      if (statusFilter !== "all" && status !== statusFilter) continue;

      hits.push({ pda: hitPda, hit, status, index: i });
    } catch (e) {
      console.log(`Hit #${i}: Failed to fetch`);
    }
  }

  if (hits.length === 0) {
    console.log("No hits found matching filter:", statusFilter);
    return;
  }

  for (const { pda, hit, status, index } of hits) {
    console.log(`Hit #${index} [${status.toUpperCase()}]`);
    console.log(`  ID: ${pda.toBase58()}`);
    console.log(`  Target: ${hit.targetDescription}`);
    console.log(`  Condition: ${hit.condition}`);
    console.log(`  Bounty: ${hit.bounty.toNumber() / LAMPORTS_PER_SOL} SOL`);
    if (!hit.anonymous) {
      console.log(`  Poster: ${hit.poster.toBase58()}`);
    } else {
      console.log(`  Poster: [Anonymous]`);
    }
    if (hit.hunter) {
      console.log(`  Hunter: ${hit.hunter.toBase58()}`);
      console.log(`  Stake: ${hit.hunterStake.toNumber() / LAMPORTS_PER_SOL} SOL`);
    }
    if (hit.proofLink) {
      console.log(`  Proof: ${hit.proofLink}`);
    }
    console.log(`  Created: ${new Date(hit.createdAt.toNumber() * 1000).toISOString()}`);
    console.log("");
  }

  console.log(`\nTotal: ${hits.length} hits`);
}

main().catch(console.error);
