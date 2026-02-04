import { loadWallet, isAgentWalletConfigured } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  const marketIdStr = process.argv[2];

  if (!marketIdStr) {
    console.log("Usage: npx ts-node scripts/prediction-start-reveal.ts <MARKET_ID>");
    console.log("\nTransitions market from Committing to Revealing phase.");
    console.log("Anyone can call this after commit deadline passes.");
    process.exit(1);
  }

  const marketPda = new PublicKey(marketIdStr);

  // Load wallet
  // Load wallet (AgentWallet aware)
  const { keypair: walletKeypair } = loadWallet();
  console.log("Caller:", walletKeypair.publicKey.toString());

  // Connect to devnet
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // Load IDL
  const idlPath = path.join(__dirname, "../target/idl/agent_casino.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider) as any;

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
  console.log("Total Committed:", market.totalCommitted.toNumber() / LAMPORTS_PER_SOL, "SOL");
  console.log("Commit Deadline:", new Date(market.commitDeadline.toNumber() * 1000).toISOString());

  const status = Object.keys(market.status)[0];
  if (status !== "committing") {
    console.log("\n⚠️  Market is already in", status, "phase");
    process.exit(0);
  }

  const now = Math.floor(Date.now() / 1000);
  if (now < market.commitDeadline.toNumber()) {
    const hoursLeft = (market.commitDeadline.toNumber() - now) / 3600;
    console.log("\n⏳ Commit phase still active.");
    console.log("Hours remaining:", hoursLeft.toFixed(1));
    console.log("Wait until:", new Date(market.commitDeadline.toNumber() * 1000).toISOString());
    process.exit(0);
  }

  console.log("\n--- Starting Reveal Phase ---");

  try {
    const tx = await program.methods
      .startRevealPhase()
      .accounts({
        market: marketPda,
      })
      .rpc();

    console.log("\n✅ Reveal phase started!");
    console.log("Transaction:", tx);
    console.log("\nBettors can now reveal their hidden bets.");
    console.log("Reveal deadline:", new Date(market.revealDeadline.toNumber() * 1000).toISOString());

  } catch (e: any) {
    console.error("\nError starting reveal phase:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
