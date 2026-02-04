import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN, web3 } from "@coral-xyz/anchor";
import { AgentCasino } from "../target/types/agent_casino";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

async function main() {
  // Load wallet
  const keyPath = path.join(process.env.HOME || "", ".config/solana/id.json");
  const rawKey = JSON.parse(fs.readFileSync(keyPath, "utf-8"));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(rawKey));

  console.log("Wallet:", wallet.publicKey.toBase58());

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

  // Derive hit vault PDA
  const [hitVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("hit_vault"), hitPoolPda.toBuffer()],
    programId
  );

  console.log("Hit Pool PDA:", hitPoolPda.toBase58());
  console.log("Hit Vault PDA:", hitVaultPda.toBase58());

  // Check if already initialized
  try {
    const existing = await program.account.hitPool.fetch(hitPoolPda);
    console.log("\nHit Pool already exists!");
    console.log("  Authority:", existing.authority.toBase58());
    console.log("  House Edge:", existing.houseEdgeBps, "bps");
    console.log("  Total Hits:", existing.totalHits.toString());
    console.log("  Total Completed:", existing.totalCompleted.toString());
    console.log("  Total Bounties Paid:", existing.totalBountiesPaid.toString(), "lamports");
    return;
  } catch (e) {
    console.log("\nHit Pool not found, initializing...");
  }

  // Initialize hit pool with 5% house edge
  const houseEdgeBps = 500; // 5%

  try {
    const tx = await program.methods
      .initializeHitPool(houseEdgeBps)
      .accountsPartial({
        hitPool: hitPoolPda,
        hitVault: hitVaultPda,
        authority: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();

    console.log("Hit Pool initialized!");
    console.log("Transaction:", tx);

    // Fetch and display
    const hitPool = await program.account.hitPool.fetch(hitPoolPda);
    console.log("\nHit Pool Stats:");
    console.log("  Authority:", hitPool.authority.toBase58());
    console.log("  House Edge:", hitPool.houseEdgeBps, "bps (", hitPool.houseEdgeBps / 100, "%)");
    console.log("  Total Hits:", hitPool.totalHits.toString());
  } catch (e) {
    console.error("Error initializing hit pool:", e);
  }
}

main().catch(console.error);
