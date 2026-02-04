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

  // Use a specific market ID for the hackathon winner market
  const marketId = new anchor.BN(20260212); // Feb 12, 2026 as unique ID

  // Derive market PDA
  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pred_mkt"), marketId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  );

  // Market parameters - top hackathon projects
  const question = "Which project wins 1st place at the Colosseum Agent Hackathon?";
  const outcomes = [
    "agent-casino-protocol",
    "clawverse",
    "solprism",
    "aegis",
    "level-5"
  ];

  // Deadlines (UTC):
  // Commit deadline: Feb 11, 2026 17:00 UTC
  // Reveal deadline: Feb 12, 2026 12:00 UTC (hackathon ends at 12:00 EST = 17:00 UTC)
  const commitDeadline = new anchor.BN(Date.UTC(2026, 1, 11, 17, 0, 0) / 1000);
  const revealDeadline = new anchor.BN(Date.UTC(2026, 1, 12, 12, 0, 0) / 1000);

  console.log("\n=== CREATING HACKATHON WINNER PREDICTION MARKET ===\n");
  console.log("Question:", question);
  console.log("Outcomes:", outcomes.join(", "));
  console.log("\nDeadlines (UTC):");
  console.log("  Commit ends:", new Date(commitDeadline.toNumber() * 1000).toISOString());
  console.log("  Reveal ends:", new Date(revealDeadline.toNumber() * 1000).toISOString());
  console.log("\nMarket PDA:", marketPda.toString());

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

    console.log("\n✅ Hackathon prediction market created!");
    console.log("Transaction:", tx);
    console.log("\n=== MARKET INFO ===");
    console.log("Market ID:", marketPda.toString());
    console.log("\nOutcomes:");
    outcomes.forEach((o, i) => console.log(`  ${i}: ${o}`));

  } catch (e: any) {
    console.error("\nError creating market:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
