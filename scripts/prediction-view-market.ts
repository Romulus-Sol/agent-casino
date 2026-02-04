import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
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
      console.log("\n" + "=".repeat(70) + "\n");
    }
  }
}

function displayMarket(publicKey: PublicKey, market: any) {
  const status = Object.keys(market.status)[0];
  const commitDeadline = new Date(market.commitDeadline.toNumber() * 1000);
  const revealDeadline = new Date(market.revealDeadline.toNumber() * 1000);
  const createdAt = new Date(market.createdAt.toNumber() * 1000);
  const now = Date.now();

  console.log("Market ID:", publicKey.toString());
  console.log("Question:", market.question);
  console.log("Created:", createdAt.toISOString());

  // Status with phase indicator
  console.log("\n--- COMMIT-REVEAL STATUS ---");
  const statusEmoji = {
    committing: "🔒",
    revealing: "👁️",
    resolved: "✅",
    cancelled: "❌"
  }[status] || "?";
  console.log(`Status: ${statusEmoji} ${status.toUpperCase()}`);

  // Phase timing
  console.log("\nPhases:");
  const commitPassed = now > commitDeadline.getTime();
  const revealPassed = now > revealDeadline.getTime();

  console.log(`  1. COMMIT: ${commitDeadline.toISOString()} ${commitPassed ? '(ended)' : '(active)'}`);
  console.log(`  2. REVEAL: ${revealDeadline.toISOString()} ${revealPassed ? '(ended)' : (commitPassed ? '(active)' : '(waiting)')}`);

  if (status === "resolved") {
    const resolvedAt = new Date(market.resolvedAt.toNumber() * 1000);
    console.log(`  3. RESOLVED: ${resolvedAt.toISOString()}`);
  }

  // Pool info
  console.log("\n--- POOL INFO ---");
  console.log("Total Committed:", (market.totalCommitted.toNumber() / LAMPORTS_PER_SOL).toFixed(4), "SOL");

  if (status === "revealing" || status === "resolved") {
    console.log("Total Pool (after reveals):", (market.totalPool.toNumber() / LAMPORTS_PER_SOL).toFixed(4), "SOL");
  }

  // Outcomes
  console.log("\n--- OUTCOMES ---");
  if (status === "committing") {
    console.log("(Bets are hidden during commit phase)");
    console.log("");
    for (let i = 0; i < market.outcomeCount; i++) {
      const name = Buffer.from(market.outcomeNames[i]).toString().replace(/\0/g, '');
      console.log(`  [${i}] ${name}`);
    }
  } else {
    // Show revealed pools
    const totalPool = market.totalPool.toNumber();
    console.log("(Revealed bets after commit phase)");
    console.log("");
    for (let i = 0; i < market.outcomeCount; i++) {
      const name = Buffer.from(market.outcomeNames[i]).toString().replace(/\0/g, '');
      const pool = market.outcomePools[i].toNumber() / LAMPORTS_PER_SOL;
      const percentage = totalPool > 0
        ? ((market.outcomePools[i].toNumber() / totalPool) * 100).toFixed(1)
        : "0.0";

      // Implied odds for pari-mutuel (ClaudeCraft's question)
      const impliedProb = totalPool > 0
        ? (market.outcomePools[i].toNumber() / totalPool)
        : 0;
      const potentialMultiplier = impliedProb > 0 ? ((0.99) / impliedProb).toFixed(2) : "∞";

      const isWinner = status === "resolved" && market.winningOutcome === i;
      const marker = isWinner ? " 🏆 WINNER" : "";

      console.log(`  [${i}] ${name.padEnd(20)} | ${pool.toFixed(4).padStart(10)} SOL | ${percentage.padStart(5)}% | ${potentialMultiplier}x${marker}`);
    }
  }

  // Pari-mutuel explanation (responding to ClaudeCraft)
  console.log("\n--- PARI-MUTUEL ODDS (how it works) ---");
  console.log("• All bets on an outcome pool together");
  console.log("• Winners split total pool proportionally to their stake");
  console.log("• Base house fee: 1% of winnings");
  console.log("• Formula: winnings = (your_bet / winning_pool) * total_pool * (1 - fee)");

  // Early bird bonus explanation (responding to ClaudeCraft's suggestion)
  console.log("\n--- 🐦 EARLY BIRD FEE REBATE ---");
  console.log("• Bet early = pay less fees!");
  console.log("• Fee discount = (time_until_deadline / total_commit_duration) * 100%");
  console.log("• Bet at market creation: 0% fee (100% discount)");
  console.log("• Bet at deadline: 1% fee (0% discount)");
  console.log("• Example: Bet halfway through → 0.5% fee");

  // Time remaining
  if (status === "committing") {
    const hoursLeft = Math.max(0, (commitDeadline.getTime() - now) / (1000 * 60 * 60));
    console.log(`\n⏰ Commit phase ends in ${hoursLeft.toFixed(1)} hours`);
    console.log("   Bets are hidden - no one can see your choice!");
  } else if (status === "revealing") {
    const hoursLeft = Math.max(0, (revealDeadline.getTime() - now) / (1000 * 60 * 60));
    console.log(`\n⏰ Reveal phase ends in ${hoursLeft.toFixed(1)} hours`);
    console.log("   Unrevealed bets will be forfeited!");
  }
}

main().catch(console.error);
