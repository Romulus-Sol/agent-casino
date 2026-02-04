import { loadWallet, isAgentWalletConfigured } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  // Load wallet
  // Load wallet (AgentWallet aware)
  const { keypair: walletKeypair } = loadWallet();
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

  // COMMIT-REVEAL TIMING (based on community feedback from Sipher):
  // - Commit phase: 7 days (until Feb 11)
  // - Reveal phase: 1 day (Feb 11-12)
  // - Resolution: After Feb 12 (hackathon ends)
  const now = Math.floor(Date.now() / 1000);
  const commitDeadline = new anchor.BN(now + 7 * 24 * 60 * 60);  // 7 days
  const revealDeadline = new anchor.BN(now + 8 * 24 * 60 * 60);  // 8 days (1 day reveal window)

  console.log("\n=== PREDICTION MARKET WITH COMMIT-REVEAL ===");
  console.log("(Implementing Sipher's privacy suggestion)\n");
  console.log("Question:", question);
  console.log("Outcomes:", outcomes.join(", "));
  console.log("\nPhases:");
  console.log("  Commit Phase Ends:", new Date(commitDeadline.toNumber() * 1000).toISOString());
  console.log("  Reveal Phase Ends:", new Date(revealDeadline.toNumber() * 1000).toISOString());
  console.log("\nMarket PDA:", marketPda.toString());

  console.log("\n--- How Commit-Reveal Works ---");
  console.log("1. COMMIT: Submit hash(outcome || salt) + lock SOL");
  console.log("   -> Your bet amount is public, but your CHOICE is hidden");
  console.log("   -> Prevents front-running and strategy copying");
  console.log("2. REVEAL: After commit deadline, reveal your choice");
  console.log("   -> Hash is verified to prove you didn't change your mind");
  console.log("3. RESOLVE: Authority declares winner");
  console.log("4. CLAIM: Winners claim proportional share (pari-mutuel)");

  try {
    const tx = await program.methods
      .createPredictionMarket(marketId, question, outcomes, commitDeadline, revealDeadline)
      .accounts({
        house: housePda,
        market: marketPda,
        authority: walletKeypair.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("\n✅ Prediction market created!");
    console.log("Transaction:", tx);
    console.log("\n=== MARKET INFO ===");
    console.log("Market ID:", marketPda.toString());
    console.log("\nOutcomes:");
    outcomes.forEach((o, i) => console.log(`  ${i}: ${o}`));
    console.log("\nShare this Market ID with agents to place hidden bets!");
    console.log("Use: npx ts-node scripts/prediction-commit-bet.ts", marketPda.toString(), "<OUTCOME> <AMOUNT>");

  } catch (e: any) {
    console.error("\nError creating market:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
