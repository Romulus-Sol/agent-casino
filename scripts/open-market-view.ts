import { loadWallet, isAgentWalletConfigured } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

// Helper to decode fixed-size byte arrays to strings
function decodeBytes(bytes: number[]): string {
  // Find first null byte and trim
  const end = bytes.indexOf(0);
  const validBytes = end >= 0 ? bytes.slice(0, end) : bytes;
  return Buffer.from(validBytes).toString('utf8');
}

async function main() {
  const marketIdStr = process.argv[2];

  // Load wallet
  // Load wallet (AgentWallet aware)
  const { keypair: walletKeypair } = loadWallet();

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
    console.log("=== All Open Prediction Markets ===\n");

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

  // Decode question from byte array
  const question = decodeBytes(market.question);

  console.log("Market ID:", publicKey.toString());
  console.log("Question:", question);
  console.log("Created:", createdAt.toISOString());

  // Status with phase indicator
  console.log("\n--- OPEN MARKET STATUS ---");
  const statusEmoji = {
    committing: "🔒",
    revealing: "👁️",
    resolved: "✅",
    cancelled: "❌"
  }[status] || "?";
  console.log(`Status: ${statusEmoji} ${status.toUpperCase()}`);

  console.log("\n🌐 OPEN MARKET: Agents can bet on ANY project slug!");
  console.log("   No fixed outcome list - unlimited possibilities");

  // Phase timing
  console.log("\nPhases:");
  const commitPassed = now > commitDeadline.getTime();
  const revealPassed = now > revealDeadline.getTime();

  console.log(`  1. COMMIT: ${commitDeadline.toISOString()} ${commitPassed ? '(ended)' : '(active)'}`);
  console.log(`  2. REVEAL: ${revealDeadline.toISOString()} ${revealPassed ? '(ended)' : (commitPassed ? '(active)' : '(waiting)')}`);

  if (status === "resolved") {
    const resolvedAt = new Date(market.resolvedAt.toNumber() * 1000);
    const winningProject = decodeBytes(market.winningProject);
    console.log(`  3. RESOLVED: ${resolvedAt.toISOString()}`);
    console.log(`\n🏆 WINNING PROJECT: ${winningProject}`);
    console.log(`   Winning Pool: ${(market.winningPool.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  }

  // Pool info
  console.log("\n--- POOL INFO ---");
  console.log("Total Committed:", (market.totalCommitted.toNumber() / LAMPORTS_PER_SOL).toFixed(4), "SOL");
  if (status === "revealing" || status === "resolved") {
    console.log("Total Pool:", (market.totalPool.toNumber() / LAMPORTS_PER_SOL).toFixed(4), "SOL");
  }

  // Pari-mutuel explanation
  console.log("\n--- HOW WINNINGS WORK ---");
  console.log("• All bets on the winning project pool together");
  console.log("• Winners split total pool proportionally to their stake");
  console.log("• Formula: winnings = (your_bet / winning_pool) * total_pool * (1 - fee)");
  console.log("• NO WINNER? If nobody predicted correctly, ALL bettors get full refunds");

  // Early bird explanation
  console.log("\n--- 🐦 EARLY BIRD FEE REBATE ---");
  console.log("• Bet early = pay less fees!");
  console.log("• Bet at market creation: 0% fee");
  console.log("• Bet at deadline: 1% fee");

  // Time remaining
  if (status === "committing") {
    const hoursLeft = Math.max(0, (commitDeadline.getTime() - now) / (1000 * 60 * 60));
    console.log(`\n⏰ Commit phase ends in ${hoursLeft.toFixed(1)} hours`);
    console.log("   Bets are hidden - no one can see your prediction!");
  } else if (status === "revealing") {
    const hoursLeft = Math.max(0, (revealDeadline.getTime() - now) / (1000 * 60 * 60));
    console.log(`\n⏰ Reveal phase ends in ${hoursLeft.toFixed(1)} hours`);
    console.log("   Unrevealed bets will be forfeited!");
  }

  // How to bet
  if (status === "committing") {
    console.log("\n--- HOW TO BET ---");
    console.log(`npx ts-node scripts/open-market-commit.ts ${publicKey.toString()} <PROJECT_SLUG> <AMOUNT_SOL>`);
    console.log("\nExample projects: clodds, sidex, superrouter, solprism, agent-casino-protocol");
  }
}

main().catch(console.error);
