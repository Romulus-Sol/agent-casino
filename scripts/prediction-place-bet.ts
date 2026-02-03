import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  // Get market ID and bet parameters from command line
  const marketIdStr = process.argv[2];
  const outcomeIndex = parseInt(process.argv[3]);
  const amountSol = parseFloat(process.argv[4]);

  if (!marketIdStr || isNaN(outcomeIndex) || isNaN(amountSol)) {
    console.log("Usage: npx ts-node scripts/prediction-place-bet.ts <MARKET_ID> <OUTCOME_INDEX> <AMOUNT_SOL>");
    console.log("Example: npx ts-node scripts/prediction-place-bet.ts 7xK... 0 0.1");
    process.exit(1);
  }

  const marketPda = new PublicKey(marketIdStr);
  const amount = new anchor.BN(amountSol * LAMPORTS_PER_SOL);

  // Load wallet
  const walletPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const walletKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
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

  // Fetch market to show current odds
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
  console.log("Total Pool:", market.totalPool.toNumber() / LAMPORTS_PER_SOL, "SOL");

  // Show outcomes and pools
  console.log("\nOutcomes:");
  for (let i = 0; i < market.outcomeCount; i++) {
    const name = Buffer.from(market.outcomeNames[i]).toString().replace(/\0/g, '');
    const pool = market.outcomePools[i].toNumber() / LAMPORTS_PER_SOL;
    const percentage = market.totalPool.toNumber() > 0
      ? ((market.outcomePools[i].toNumber() / market.totalPool.toNumber()) * 100).toFixed(1)
      : "0.0";
    console.log(`  ${i}: ${name.padEnd(20)} - ${pool.toFixed(4)} SOL (${percentage}%)`);
  }

  if (Object.keys(market.status)[0] !== "open") {
    console.error("\nMarket is not open for betting");
    process.exit(1);
  }

  if (outcomeIndex >= market.outcomeCount) {
    console.error(`\nInvalid outcome index. Must be 0-${market.outcomeCount - 1}`);
    process.exit(1);
  }

  console.log("\n--- Placing Bet ---");
  console.log("Outcome:", outcomeIndex);
  console.log("Amount:", amountSol, "SOL");

  try {
    const tx = await program.methods
      .placePredictionBet(outcomeIndex, amount)
      .accounts({
        house: housePda,
        market: marketPda,
        bet: betPda,
        bettor: walletKeypair.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("\nBet placed!");
    console.log("Transaction:", tx);

    // Fetch updated market
    const updatedMarket = await program.account.predictionMarket.fetch(marketPda);
    console.log("\nNew Total Pool:", updatedMarket.totalPool.toNumber() / LAMPORTS_PER_SOL, "SOL");

    // Calculate potential payout
    const outcomePool = updatedMarket.outcomePools[outcomeIndex].toNumber();
    const totalPool = updatedMarket.totalPool.toNumber();
    const houseEdge = 0.01; // 1%
    const payoutPool = totalPool * (1 - houseEdge);
    const myShare = amount.toNumber() / outcomePool;
    const potentialPayout = payoutPool * myShare;

    console.log("\n--- If You Win ---");
    console.log("Your share of winning pool:", (myShare * 100).toFixed(2) + "%");
    console.log("Potential payout:", (potentialPayout / LAMPORTS_PER_SOL).toFixed(4), "SOL");
    console.log("Potential profit:", ((potentialPayout - amount.toNumber()) / LAMPORTS_PER_SOL).toFixed(4), "SOL");

  } catch (e: any) {
    console.error("\nError placing bet:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
