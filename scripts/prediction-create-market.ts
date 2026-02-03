import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  // Load wallet
  const walletPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const walletKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  console.log("Authority:", walletKeypair.publicKey.toString());

  // Connect to devnet
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // Load IDL
  const idlPath = path.join(__dirname, "../target/idl/agent_casino.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider) as any;

  // Derive house PDA
  const [housePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("house")],
    PROGRAM_ID
  );

  // Generate unique market ID
  const marketId = new anchor.BN(Date.now());

  // Derive market PDA
  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pred_mkt"), marketId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  );

  // Market parameters
  const question = "Which project wins 1st place at the Agent Hackathon?";
  const outcomes = [
    "agent-casino",
    "clawverse",
    "sipher",
    "claudecraft",
    "other"
  ];

  // Close in 9 days (Feb 12 deadline)
  const closesAt = new anchor.BN(Math.floor(Date.now() / 1000) + 9 * 24 * 60 * 60);

  console.log("\n--- Creating Prediction Market ---");
  console.log("Question:", question);
  console.log("Outcomes:", outcomes.join(", "));
  console.log("Closes at:", new Date(closesAt.toNumber() * 1000).toISOString());
  console.log("Market PDA:", marketPda.toString());

  try {
    const tx = await program.methods
      .createPredictionMarket(marketId, question, outcomes, closesAt)
      .accounts({
        house: housePda,
        market: marketPda,
        authority: walletKeypair.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("\nPrediction market created!");
    console.log("Transaction:", tx);
    console.log("\n=== MARKET INFO ===");
    console.log("Market ID:", marketPda.toString());
    console.log("Question:", question);
    console.log("\nOutcomes:");
    outcomes.forEach((o, i) => console.log(`  ${i}: ${o}`));
    console.log("\nShare this Market ID with agents to place bets!");

  } catch (e: any) {
    console.error("\nError creating market:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
