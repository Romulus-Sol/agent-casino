import { loadWallet, isAgentWalletConfigured } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  // Get challenge ID from command line
  const challengeId = process.argv[2];
  if (!challengeId) {
    console.log("Usage: npx ts-node scripts/pvp-cancel-challenge.ts <CHALLENGE_ID>");
    process.exit(1);
  }

  const challengePda = new PublicKey(challengeId);

  // Load wallet
  // Load wallet (AgentWallet aware)
  const { keypair: walletKeypair } = loadWallet();
  console.log("Wallet:", walletKeypair.publicKey.toString());

  // Connect to devnet
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // Load IDL
  const idlPath = path.join(__dirname, "../target/idl/agent_casino.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider) as any;

  // Fetch challenge
  let challenge;
  try {
    challenge = await program.account.challenge.fetch(challengePda);
  } catch (e) {
    console.error("Challenge not found:", challengeId);
    process.exit(1);
  }

  console.log("\n--- Challenge Details ---");
  console.log("Challenger:", challenge.challenger.toString());
  console.log("Amount:", challenge.amount.toNumber() / LAMPORTS_PER_SOL, "SOL");
  console.log("Status:", Object.keys(challenge.status)[0]);

  if (Object.keys(challenge.status)[0] !== "open") {
    console.error("\nChallenge is not open - cannot cancel");
    process.exit(1);
  }

  if (challenge.challenger.toString() !== walletKeypair.publicKey.toString()) {
    console.error("\nYou are not the challenger - cannot cancel");
    process.exit(1);
  }

  console.log("\n--- Cancelling Challenge ---");

  try {
    const tx = await program.methods
      .cancelChallenge()
      .accounts({
        challenge: challengePda,
        challenger: walletKeypair.publicKey,
      })
      .rpc();

    console.log("Challenge cancelled!");
    console.log("Transaction:", tx);
    console.log("Refunded:", challenge.amount.toNumber() / LAMPORTS_PER_SOL, "SOL");

  } catch (e: any) {
    console.error("\nError cancelling challenge:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
