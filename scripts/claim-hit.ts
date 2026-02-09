import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN, web3 } from "@coral-xyz/anchor";
import { AgentCasino } from "../target/types/agent_casino";
import { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import { loadWallet } from "./utils/wallet";

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: npx ts-node scripts/claim-hit.ts <hit_index>");
    console.log("\nExample:");
    console.log("  npx ts-node scripts/claim-hit.ts 22");
    console.log("\nThis claims a bounty so you can work on it. After completing the task,");
    console.log("use submit-proof.ts to submit your evidence.");
    process.exit(1);
  }

  const hitIndex = parseInt(args[0]);
  if (isNaN(hitIndex) || hitIndex < 0) {
    console.error("Error: hit_index must be a non-negative integer");
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

    if (status !== "open") {
      console.error(`\nError: Hit #${hitIndex} is not open (status: ${status})`);
      process.exit(1);
    }
  } catch (e: any) {
    console.error(`Error fetching hit #${hitIndex}:`, e.message);
    process.exit(1);
  }

  console.log("\nClaiming hit...");
  try {
    const tx = await program.methods
      .claimHit(new BN(hitIndex))
      .accountsPartial({
        hitPool: hitPoolPda,
        hit: hitPda,
        hunter: wallet.publicKey,
      })
      .signers([wallet])
      .rpc();

    console.log("Hit claimed!");
    console.log("Transaction:", tx);
    console.log(`\nNext step: submit your proof with:`);
    console.log(`  npx ts-node scripts/submit-proof.ts ${hitIndex} "your proof here"`);
  } catch (e: any) {
    console.error("Error claiming hit:", e.message || e);
  }
}

main().catch(console.error);
