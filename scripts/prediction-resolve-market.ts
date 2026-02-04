import { loadWallet, isAgentWalletConfigured } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  // Get market ID and winning outcome from command line
  const marketIdStr = process.argv[2];
  const winningOutcome = parseInt(process.argv[3]);

  if (!marketIdStr || isNaN(winningOutcome)) {
    console.log("Usage: npx ts-node scripts/prediction-resolve-market.ts <MARKET_ID> <WINNING_OUTCOME_INDEX>");
    console.log("Example: npx ts-node scripts/prediction-resolve-market.ts 7xK... 0");
    process.exit(1);
  }

  const marketPda = new PublicKey(marketIdStr);

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

  // Fetch market
  let market;
  try {
    market = await program.account.predictionMarket.fetch(marketPda);
  } catch (e) {
    console.error("Market not found:", marketIdStr);
    process.exit(1);
  }

  console.log("\n--- Market Details ---");
  console.log("Question:", market.question);
  console.log("Status:", Object.keys(market.status)[0]);
  console.log("Authority:", market.authority.toString());
  console.log("Total Pool:", market.totalPool.toNumber() / LAMPORTS_PER_SOL, "SOL");

  console.log("\nOutcomes:");
  for (let i = 0; i < market.outcomeCount; i++) {
    const name = Buffer.from(market.outcomeNames[i]).toString().replace(/\0/g, '');
    const pool = market.outcomePools[i].toNumber() / LAMPORTS_PER_SOL;
    console.log(`  ${i}: ${name.padEnd(20)} - ${pool.toFixed(4)} SOL`);
  }

  if (Object.keys(market.status)[0] !== "open") {
    console.error("\nMarket is not open - cannot resolve");
    process.exit(1);
  }

  if (market.authority.toString() !== walletKeypair.publicKey.toString()) {
    console.error("\nYou are not the market authority - cannot resolve");
    process.exit(1);
  }

  if (winningOutcome >= market.outcomeCount) {
    console.error(`\nInvalid outcome index. Must be 0-${market.outcomeCount - 1}`);
    process.exit(1);
  }

  const winningName = Buffer.from(market.outcomeNames[winningOutcome]).toString().replace(/\0/g, '');
  console.log("\n--- Resolving Market ---");
  console.log("Winning outcome:", winningOutcome, "-", winningName);

  // Calculate house take
  const totalPool = market.totalPool.toNumber();
  const houseTake = totalPool * 0.01; // 1% house edge
  const winnerPool = totalPool - houseTake;

  console.log("Total pool:", totalPool / LAMPORTS_PER_SOL, "SOL");
  console.log("House take (1%):", houseTake / LAMPORTS_PER_SOL, "SOL");
  console.log("Winner pool:", winnerPool / LAMPORTS_PER_SOL, "SOL");

  try {
    const tx = await program.methods
      .resolvePredictionMarket(winningOutcome)
      .accounts({
        house: housePda,
        market: marketPda,
        authority: walletKeypair.publicKey,
      })
      .rpc();

    console.log("\nMarket resolved!");
    console.log("Transaction:", tx);
    console.log("\nWinners can now claim their winnings!");

  } catch (e: any) {
    console.error("\nError resolving market:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
