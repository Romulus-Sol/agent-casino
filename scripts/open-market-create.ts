import { loadWallet, isAgentWalletConfigured } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  const question = process.argv[2];
  const commitHours = parseInt(process.argv[3]) || 168; // Default 7 days
  const revealHours = parseInt(process.argv[4]) || 12;  // Default 12 hours after commit

  if (!question) {
    console.log("Usage: npx ts-node scripts/open-market-create.ts <QUESTION> [COMMIT_HOURS] [REVEAL_HOURS]");
    console.log("Example: npx ts-node scripts/open-market-create.ts 'Which project wins 1st place?' 168 12");
    console.log("\nOPEN MARKET: Agents can bet on ANY project - no fixed outcome list!");
    process.exit(1);
  }

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

  // Use timestamp as unique market ID
  const marketId = new anchor.BN(Date.now());

  // Derive market PDA
  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pred_mkt"), marketId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  );

  // Calculate deadlines
  const now = Math.floor(Date.now() / 1000);
  const commitDeadline = new anchor.BN(now + commitHours * 3600);
  const revealDeadline = new anchor.BN(now + commitHours * 3600 + revealHours * 3600);

  console.log("\n=== CREATING OPEN PREDICTION MARKET ===\n");
  console.log("Question:", question);
  console.log("\nOPEN MARKET DESIGN:");
  console.log("  - Agents bet on ANY project slug (e.g., 'clodds', 'agent-casino-protocol')");
  console.log("  - No fixed outcome list - unlimited possibilities");
  console.log("  - All correct predictions split the pool proportionally");
  console.log("\nDeadlines:");
  console.log("  Commit ends:", new Date(commitDeadline.toNumber() * 1000).toISOString());
  console.log("  Reveal ends:", new Date(revealDeadline.toNumber() * 1000).toISOString());
  console.log("\nMarket PDA:", marketPda.toString());

  try {
    const tx = await program.methods
      .createPredictionMarket(marketId, question, commitDeadline, revealDeadline)
      .accounts({
        house: housePda,
        market: marketPda,
        authority: walletKeypair.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("\n✅ Open prediction market created!");
    console.log("Transaction:", tx);
    console.log("\n=== MARKET INFO ===");
    console.log("Market ID:", marketPda.toString());
    console.log("\nHow to bet:");
    console.log(`  npx ts-node scripts/open-market-commit.ts ${marketPda.toString()} <PROJECT_SLUG> <AMOUNT_SOL>`);

  } catch (e: any) {
    console.error("\nError creating market:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
