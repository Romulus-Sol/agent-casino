import { loadWallet, isAgentWalletConfigured } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  // Parse arguments - can either provide reveal file or manual parameters
  const arg = process.argv[2];

  let marketPda: PublicKey;
  let outcomeIndex: number;
  let salt: Buffer;

  if (arg && arg.endsWith('.json')) {
    // Load from reveal file
    const revealInfo = JSON.parse(fs.readFileSync(arg, "utf-8"));
    marketPda = new PublicKey(revealInfo.market);
    outcomeIndex = revealInfo.outcome;
    salt = Buffer.from(revealInfo.salt, 'hex');
    console.log("Loaded reveal info from:", arg);
  } else if (process.argv.length >= 5) {
    // Manual parameters
    marketPda = new PublicKey(process.argv[2]);
    outcomeIndex = parseInt(process.argv[3]);
    salt = Buffer.from(process.argv[4], 'hex');
  } else {
    console.log("Usage:");
    console.log("  npx ts-node scripts/prediction-reveal-bet.ts <REVEAL_FILE.json>");
    console.log("  npx ts-node scripts/prediction-reveal-bet.ts <MARKET_ID> <OUTCOME_INDEX> <SALT_HEX>");
    console.log("\nExample:");
    console.log("  npx ts-node scripts/prediction-reveal-bet.ts reveal-7xK-Cwg.json");
    process.exit(1);
  }

  // Load wallet
  // Load wallet (AgentWallet aware)
  const { keypair: walletKeypair } = loadWallet();
  console.log("Bettor:", walletKeypair.publicKey.toString());

  // Connect to devnet
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // Load IDL
  const idlPath = path.join(__dirname, "../target/idl/agent_casino.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider) as any;

  // Derive bet PDA
  const [betPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pred_bet"), marketPda.toBuffer(), walletKeypair.publicKey.toBuffer()],
    PROGRAM_ID
  );

  // Fetch market
  let market;
  try {
    market = await program.account.predictionMarket.fetch(marketPda);
  } catch (e) {
    console.error("Market not found");
    process.exit(1);
  }

  // Fetch bet
  let bet;
  try {
    bet = await program.account.predictionBet.fetch(betPda);
  } catch (e) {
    console.error("Bet not found - you haven't committed to this market");
    process.exit(1);
  }

  console.log("\n--- Market Details ---");
  console.log("Question:", market.question);
  console.log("Status:", Object.keys(market.status)[0]);

  const outcomeName = Buffer.from(market.outcomeNames[outcomeIndex]).toString().replace(/\0/g, '');

  console.log("\n--- Your Bet ---");
  console.log("Amount:", bet.amount.toNumber() / LAMPORTS_PER_SOL, "SOL");
  console.log("Already revealed:", bet.revealed);
  console.log("Your choice to reveal:", outcomeIndex, "-", outcomeName);

  if (bet.revealed) {
    console.log("\n✅ Your bet has already been revealed!");
    process.exit(0);
  }

  const status = Object.keys(market.status)[0];
  if (status === "committing") {
    // Check if commit phase ended
    const now = Math.floor(Date.now() / 1000);
    if (now < market.commitDeadline.toNumber()) {
      console.log("\n⏳ Commit phase still active. Wait until:", new Date(market.commitDeadline.toNumber() * 1000).toISOString());
      console.log("Then run: npx ts-node scripts/prediction-start-reveal.ts", marketPda.toString());
      process.exit(0);
    }
    console.log("\n⚠️  Commit phase ended but reveal phase not started.");
    console.log("Run first: npx ts-node scripts/prediction-start-reveal.ts", marketPda.toString());
    process.exit(1);
  }

  if (status !== "revealing") {
    console.error("\n❌ Market is not in reveal phase");
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  if (now >= market.revealDeadline.toNumber()) {
    console.error("\n❌ Reveal phase has ended! Your bet will be forfeited.");
    process.exit(1);
  }

  console.log("\n--- Revealing Bet ---");
  console.log("Outcome:", outcomeIndex, "-", outcomeName);
  console.log("Salt:", salt.toString('hex').slice(0, 16) + "...");

  try {
    const tx = await program.methods
      .revealPredictionBet(outcomeIndex, Array.from(salt))
      .accounts({
        market: marketPda,
        bet: betPda,
        bettor: walletKeypair.publicKey,
      })
      .rpc();

    console.log("\n✅ Bet revealed successfully!");
    console.log("Transaction:", tx);

    // Fetch updated market to show current odds
    const updatedMarket = await program.account.predictionMarket.fetch(marketPda);

    console.log("\n--- Current Odds (after reveals) ---");
    for (let i = 0; i < updatedMarket.outcomeCount; i++) {
      const name = Buffer.from(updatedMarket.outcomeNames[i]).toString().replace(/\0/g, '');
      const pool = updatedMarket.outcomePools[i].toNumber() / LAMPORTS_PER_SOL;
      console.log(`  ${i}: ${name.padEnd(20)} - ${pool.toFixed(4)} SOL`);
    }

    console.log("\nWait for market resolution to claim winnings!");
    console.log("Reveal deadline:", new Date(market.revealDeadline.toNumber() * 1000).toISOString());

  } catch (e: any) {
    console.error("\nError revealing bet:", e.message);
    if (e.message.includes("InvalidReveal")) {
      console.error("\n⚠️  The salt or outcome doesn't match your commitment!");
      console.error("Make sure you're using the exact same values you committed with.");
    }
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
