import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  // Connect to devnet
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");

  // Create a minimal provider (no wallet needed for reading)
  const provider = new anchor.AnchorProvider(connection, {} as any, {});

  // Load IDL
  const idlPath = path.join(__dirname, "../target/idl/agent_casino.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider) as any;

  console.log("=== Open PvP Challenges ===\n");

  try {
    // Fetch all challenge accounts
    const challenges = await program.account.challenge.all();

    const openChallenges = challenges.filter((c: any) =>
      Object.keys(c.account.status)[0] === "open"
    );

    if (openChallenges.length === 0) {
      console.log("No open challenges found.");
      console.log("\nCreate one with: npx ts-node scripts/pvp-create-challenge.ts");
      return;
    }

    console.log(`Found ${openChallenges.length} open challenge(s):\n`);

    for (const { publicKey, account } of openChallenges) {
      console.log("Challenge ID:", publicKey.toString());
      console.log("  Challenger:", account.challenger.toString());
      console.log("  Amount:", account.amount.toNumber() / LAMPORTS_PER_SOL, "SOL");
      console.log("  Choice:", account.choice === 0 ? "HEADS" : "TAILS");
      console.log("  Your side if you accept:", account.choice === 0 ? "TAILS" : "HEADS");
      console.log("  Created:", new Date(account.createdAt.toNumber() * 1000).toISOString());
      console.log("");
    }

    console.log("To accept a challenge:");
    console.log("npx ts-node scripts/pvp-accept-challenge.ts <CHALLENGE_ID>");

  } catch (e: any) {
    console.error("Error fetching challenges:", e.message);
  }
}

main().catch(console.error);
