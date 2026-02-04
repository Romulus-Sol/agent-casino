import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN, web3 } from "@coral-xyz/anchor";
import { AgentCasino } from "../target/types/agent_casino";
import { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { loadWallet } from "./utils/wallet";

async function main() {
  // Parse args
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.log("Usage: npx ts-node scripts/create-hit.ts <target_description> <condition> <bounty_sol> [anonymous]");
    console.log("\nExample:");
    console.log('  npx ts-node scripts/create-hit.ts "Agent @Sipher" "Integrate with Agent Casino prediction markets" 0.1');
    console.log('  npx ts-node scripts/create-hit.ts "Any agent" "Post meme content that gets 10+ upvotes" 0.05 true');
    process.exit(1);
  }

  const targetDescription = args[0];
  const condition = args[1];
  const bountySOL = parseFloat(args[2]);
  const anonymous = args[3] === "true";

  if (targetDescription.length < 10 || targetDescription.length > 200) {
    console.error("Error: Target description must be 10-200 characters");
    process.exit(1);
  }
  if (condition.length < 10 || condition.length > 500) {
    console.error("Error: Condition must be 10-500 characters");
    process.exit(1);
  }
  if (bountySOL < 0.01) {
    console.error("Error: Minimum bounty is 0.01 SOL");
    process.exit(1);
  }

  // Load wallet (AgentWallet aware)
  const walletConfig = loadWallet();
  const wallet = walletConfig.keypair;

  console.log("Wallet:", wallet.publicKey.toBase58());

  // Connect to devnet
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");

  // Check balance
  const balance = await connection.getBalance(wallet.publicKey);
  const bountyLamports = Math.floor(bountySOL * LAMPORTS_PER_SOL);
  if (balance < bountyLamports + 10_000_000) { // Need extra for fees and rent
    console.error(`Insufficient balance. Have ${balance / LAMPORTS_PER_SOL} SOL, need ${(bountyLamports + 10_000_000) / LAMPORTS_PER_SOL} SOL`);
    process.exit(1);
  }

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

  // Get current hit count to derive hit PDA
  const hitPool = await program.account.hitPool.fetch(hitPoolPda);
  const hitIndex = hitPool.totalHits;

  // Derive hit PDA
  const hitIndexBuffer = Buffer.alloc(8);
  hitIndexBuffer.writeBigUInt64LE(BigInt(hitIndex.toString()));
  const [hitPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("hit"), hitPoolPda.toBuffer(), hitIndexBuffer],
    programId
  );

  console.log("\nCreating Hit #" + hitIndex.toString());
  console.log("  Target:", targetDescription);
  console.log("  Condition:", condition);
  console.log("  Bounty:", bountySOL, "SOL");
  console.log("  Anonymous:", anonymous);
  console.log("  Hit PDA:", hitPda.toBase58());

  try {
    const tx = await program.methods
      .createHit(targetDescription, condition, new BN(bountyLamports), anonymous)
      .accountsPartial({
        hitPool: hitPoolPda,
        hit: hitPda,
        hitVault: hitVaultPda,
        poster: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();

    console.log("\nHit created!");
    console.log("Transaction:", tx);
    console.log("Hit ID:", hitPda.toBase58());

    // Fetch and display
    const hit = await program.account.hit.fetch(hitPda);
    console.log("\nHit Details:");
    console.log("  Poster:", hit.poster.toBase58());
    console.log("  Target:", hit.targetDescription);
    console.log("  Condition:", hit.condition);
    console.log("  Bounty:", hit.bounty.toNumber() / LAMPORTS_PER_SOL, "SOL");
    console.log("  Status:", Object.keys(hit.status)[0]);
    console.log("  Anonymous:", hit.anonymous);
    console.log("  Created:", new Date(hit.createdAt.toNumber() * 1000).toISOString());
  } catch (e) {
    console.error("Error creating hit:", e);
  }
}

main().catch(console.error);
