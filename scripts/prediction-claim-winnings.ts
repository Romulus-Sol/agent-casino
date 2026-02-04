import { loadWallet, isAgentWalletConfigured } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  // Get market ID from command line
  const marketIdStr = process.argv[2];

  if (!marketIdStr) {
    console.log("Usage: npx ts-node scripts/prediction-claim-winnings.ts <MARKET_ID>");
    process.exit(1);
  }

  const marketPda = new PublicKey(marketIdStr);

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

  // Derive house PDA
  const [housePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("house")],
    PROGRAM_ID
  );

  // Derive bet PDA
  const [betPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pred_bet"), marketPda.toBuffer(), walletKeypair.publicKey.toBuffer()],
    PROGRAM_ID
  );

  // Derive agent stats PDA
  const [agentStatsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), walletKeypair.publicKey.toBuffer()],
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

  // Fetch bet
  let bet;
  try {
    bet = await program.account.predictionBet.fetch(betPda);
  } catch (e) {
    console.error("You don't have a bet on this market");
    process.exit(1);
  }

  console.log("\n--- Market Details ---");
  console.log("Question:", market.question);
  console.log("Status:", Object.keys(market.status)[0]);

  const winningName = Buffer.from(market.outcomeNames[market.winningOutcome]).toString().replace(/\0/g, '');
  console.log("Winning outcome:", market.winningOutcome, "-", winningName);

  console.log("\n--- Your Bet ---");
  const yourOutcomeName = Buffer.from(market.outcomeNames[bet.outcomeIndex]).toString().replace(/\0/g, '');
  console.log("Your pick:", bet.outcomeIndex, "-", yourOutcomeName);
  console.log("Your bet amount:", bet.amount.toNumber() / LAMPORTS_PER_SOL, "SOL");
  console.log("Claimed:", bet.claimed);

  if (Object.keys(market.status)[0] !== "resolved") {
    console.error("\nMarket is not resolved yet - cannot claim");
    process.exit(1);
  }

  if (bet.claimed) {
    console.error("\nYou have already claimed your winnings");
    process.exit(1);
  }

  if (bet.outcomeIndex !== market.winningOutcome) {
    console.log("\n❌ Sorry, you did not win this market.");
    console.log("Your pick:", yourOutcomeName);
    console.log("Winning outcome:", winningName);
    process.exit(0);
  }

  // Calculate winnings
  const winningPool = market.outcomePools[market.winningOutcome].toNumber();
  const totalPool = market.totalPool.toNumber();
  const houseTake = totalPool * 0.01;
  const payoutPool = totalPool - houseTake;
  const myShare = bet.amount.toNumber() / winningPool;
  const winnings = payoutPool * myShare;

  console.log("\n--- Claiming Winnings ---");
  console.log("Your share of winning pool:", (myShare * 100).toFixed(2) + "%");
  console.log("Winnings:", winnings / LAMPORTS_PER_SOL, "SOL");
  console.log("Profit:", (winnings - bet.amount.toNumber()) / LAMPORTS_PER_SOL, "SOL");

  try {
    const tx = await program.methods
      .claimPredictionWinnings()
      .accounts({
        house: housePda,
        market: marketPda,
        bet: betPda,
        agentStats: agentStatsPda,
        bettor: walletKeypair.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("\n🎉 Winnings claimed!");
    console.log("Transaction:", tx);

    const newBalance = await connection.getBalance(walletKeypair.publicKey);
    console.log("Your new balance:", newBalance / LAMPORTS_PER_SOL, "SOL");

  } catch (e: any) {
    console.error("\nError claiming winnings:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
