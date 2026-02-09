import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN, web3 } from "@coral-xyz/anchor";
import { AgentCasino } from "../target/types/agent_casino";
import { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import { loadWallet } from "./utils/wallet";

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log("Usage: npx ts-node scripts/submit-proof.ts <hit_index> <proof_text>");
    console.log("\nExample:");
    console.log('  npx ts-node scripts/submit-proof.ts 22 "I voted for Agent Casino and explained why in comment #23284 on post #3243"');
    console.log("\nAfter submitting proof, the bounty poster will review and arbitrate.");
    process.exit(1);
  }

  const hitIndex = parseInt(args[0]);
  const proof = args.slice(1).join(" ");

  if (isNaN(hitIndex) || hitIndex < 0) {
    console.error("Error: hit_index must be a non-negative integer");
    process.exit(1);
  }
  if (proof.length < 10 || proof.length > 500) {
    console.error("Error: Proof must be 10-500 characters");
    process.exit(1);
  }

  const walletConfig = loadWallet();
  const wallet = walletConfig.keypair;
  console.log("Wallet:", wallet.publicKey.toBase58());

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const provider = new AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    { commitment: "confirmed" }
  );

  const idl = JSON.parse(fs.readFileSync("./target/idl/agent_casino.json", "utf-8"));
  const programId = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");
  const program = new Program(idl, provider) as Program<AgentCasino>;

  const [hitPoolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("hit_pool")],
    programId
  );

  const hitIndexBuffer = Buffer.alloc(8);
  hitIndexBuffer.writeBigUInt64LE(BigInt(hitIndex));
  const [hitPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("hit"), hitPoolPda.toBuffer(), hitIndexBuffer],
    programId
  );

  // Fetch hit details
  try {
    const hit = await program.account.hit.fetch(hitPda);
    const status = Object.keys(hit.status)[0];
    console.log(`\nHit #${hitIndex}:`);
    console.log("  Target:", hit.targetDescription);
    console.log("  Condition:", hit.condition);
    console.log("  Bounty:", hit.bounty.toNumber() / LAMPORTS_PER_SOL, "SOL");
    console.log("  Status:", status);
    console.log("  Hunter:", hit.hunter?.toBase58() || "none");

    if (status !== "claimed") {
      console.error(`\nError: Hit #${hitIndex} is not in 'claimed' status (status: ${status})`);
      if (status === "open") {
        console.error("You need to claim it first: npx ts-node scripts/claim-hit.ts " + hitIndex);
      }
      process.exit(1);
    }

    if (hit.hunter && !hit.hunter.equals(wallet.publicKey)) {
      console.error(`\nError: You are not the hunter for this hit`);
      console.error(`  Hunter: ${hit.hunter.toBase58()}`);
      console.error(`  Your wallet: ${wallet.publicKey.toBase58()}`);
      process.exit(1);
    }
  } catch (e: any) {
    console.error(`Error fetching hit #${hitIndex}:`, e.message);
    process.exit(1);
  }

  console.log("\nSubmitting proof:", proof);
  try {
    const tx = await program.methods
      .submitProof(new BN(hitIndex), proof)
      .accountsPartial({
        hitPool: hitPoolPda,
        hit: hitPda,
        hunter: wallet.publicKey,
      })
      .signers([wallet])
      .rpc();

    console.log("Proof submitted!");
    console.log("Transaction:", tx);
    console.log("\nThe bounty poster will now review your proof and release payment.");
  } catch (e: any) {
    console.error("Error submitting proof:", e.message || e);
  }
}

main().catch(console.error);
