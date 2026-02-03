import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  // Get market ID from command line (optional)
  const marketIdStr = process.argv[2];

  // Load wallet
  const walletPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const walletKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );

  // Connect to devnet
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // Load IDL
  const idlPath = path.join(__dirname, "../target/idl/agent_casino.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider) as any;

  if (marketIdStr) {
    // View specific market
    const marketPda = new PublicKey(marketIdStr);
    try {
      const market = await program.account.predictionMarket.fetch(marketPda);
      displayMarket(marketPda, market);
    } catch (e) {
      console.error("Market not found:", marketIdStr);
      process.exit(1);
    }
  } else {
    // List all markets
    console.log("=== All Prediction Markets ===\n");

    const markets = await program.account.predictionMarket.all();

    if (markets.length === 0) {
      console.log("No prediction markets found.");
      return;
    }

    for (const { publicKey, account } of markets) {
      displayMarket(publicKey, account);
      console.log("\n" + "=".repeat(60) + "\n");
    }
  }
}

function displayMarket(publicKey: PublicKey, market: any) {
  const status = Object.keys(market.status)[0];
  const closesAt = new Date(market.closesAt.toNumber() * 1000);
  const createdAt = new Date(market.createdAt.toNumber() * 1000);

  console.log("Market ID:", publicKey.toString());
  console.log("Question:", market.question);
  console.log("Status:", status.toUpperCase());
  console.log("Created:", createdAt.toISOString());
  console.log("Closes:", closesAt.toISOString());
  console.log("Total Pool:", (market.totalPool.toNumber() / LAMPORTS_PER_SOL).toFixed(4), "SOL");

  if (status === "resolved") {
    console.log("Winning Outcome:", market.winningOutcome);
    console.log("Resolved At:", new Date(market.resolvedAt.toNumber() * 1000).toISOString());
  }

  console.log("\nOutcomes & Odds:");
  for (let i = 0; i < market.outcomeCount; i++) {
    const name = Buffer.from(market.outcomeNames[i]).toString().replace(/\0/g, '');
    const pool = market.outcomePools[i].toNumber() / LAMPORTS_PER_SOL;
    const percentage = market.totalPool.toNumber() > 0
      ? ((market.outcomePools[i].toNumber() / market.totalPool.toNumber()) * 100).toFixed(1)
      : "0.0";

    // Calculate implied probability and potential return
    const impliedProb = market.totalPool.toNumber() > 0
      ? (market.outcomePools[i].toNumber() / market.totalPool.toNumber())
      : 0;
    const potentialMultiplier = impliedProb > 0 ? ((1 - 0.01) / impliedProb).toFixed(2) : "∞";

    const isWinner = status === "resolved" && market.winningOutcome === i;
    const marker = isWinner ? " 🏆" : "";

    console.log(`  [${i}] ${name.padEnd(20)} | ${pool.toFixed(4).padStart(10)} SOL | ${percentage.padStart(5)}% | ${potentialMultiplier}x${marker}`);
  }

  if (status === "open") {
    const now = Date.now();
    const closeTime = closesAt.getTime();
    const hoursLeft = Math.max(0, (closeTime - now) / (1000 * 60 * 60));
    console.log(`\n⏰ Betting closes in ${hoursLeft.toFixed(1)} hours`);
  }
}

main().catch(console.error);
