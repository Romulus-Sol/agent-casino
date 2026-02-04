import { loadWallet, isAgentWalletConfigured } from "./utils/wallet";
/**
 * Create a price prediction bet
 * Usage: npx ts-node scripts/price-create.ts <asset> <target_price> <above|below> <duration_mins> <amount>
 * Example: npx ts-node scripts/price-create.ts BTC 100000 above 60 0.1
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

// Program ID
const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

// Pyth devnet price feed addresses
const PYTH_FEEDS: Record<string, PublicKey> = {
  BTC: new PublicKey("HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J"),
  SOL: new PublicKey("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"),
  ETH: new PublicKey("EdVCmQ9FSPcVe5YySXDPCRmc8aDQLKJ9xvYBMZPie1Vw"),
};

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 5) {
    console.log("Usage: npx ts-node scripts/price-create.ts <asset> <target_price> <above|below> <duration_mins> <amount>");
    console.log("Example: npx ts-node scripts/price-create.ts BTC 100000 above 60 0.1");
    console.log("\nAssets: BTC, SOL, ETH");
    process.exit(1);
  }

  const [assetStr, targetPriceStr, directionStr, durationStr, amountStr] = args;

  // Parse asset
  const asset = assetStr.toUpperCase();
  if (!["BTC", "SOL", "ETH"].includes(asset)) {
    console.error("Invalid asset. Must be BTC, SOL, or ETH");
    process.exit(1);
  }
  const assetEnum = { [asset.toLowerCase()]: {} };

  // Parse target price (convert to Pyth format with 8 decimals)
  const targetPrice = Math.round(parseFloat(targetPriceStr) * 1e8);

  // Parse direction
  const direction = directionStr.toLowerCase();
  if (!["above", "below"].includes(direction)) {
    console.error("Invalid direction. Must be 'above' or 'below'");
    process.exit(1);
  }
  const directionEnum = { [direction]: {} };

  // Parse duration (convert minutes to seconds)
  const durationSeconds = parseInt(durationStr) * 60;

  // Parse amount
  const amountSol = parseFloat(amountStr);
  const amountLamports = new anchor.BN(amountSol * LAMPORTS_PER_SOL);

  // Setup connection
  const connection = new anchor.web3.Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );

  // Load wallet
  // Load wallet (AgentWallet aware)
  const { keypair: walletKeypair } = loadWallet();
  const wallet = new anchor.Wallet(walletKeypair);

  // Create provider
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  // Load IDL
  const idlPath = "./target/idl/agent_casino.json";
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new Program(idl, provider);

  // Derive PDAs
  const [housePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("house")],
    PROGRAM_ID
  );

  // Get current game count for PDA
  const houseAccount = await (program.account as any).house.fetch(housePda);
  const gameCount = houseAccount.totalGames;

  const [pricePredictionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("price_bet"), housePda.toBuffer(), gameCount.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  );

  console.log("\n=== Creating Price Prediction ===");
  console.log(`Asset: ${asset}`);
  console.log(`Target Price: $${targetPriceStr}`);
  console.log(`Direction: ${direction}`);
  console.log(`Duration: ${durationStr} minutes`);
  console.log(`Bet Amount: ${amountSol} SOL`);
  console.log(`Pyth Feed: ${PYTH_FEEDS[asset].toString()}`);
  console.log(`Prediction PDA: ${pricePredictionPda.toString()}`);

  try {
    const tx = await (program.methods as any)
      .createPricePrediction(
        assetEnum,
        new anchor.BN(targetPrice),
        directionEnum,
        new anchor.BN(durationSeconds),
        amountLamports
      )
      .accounts({
        house: housePda,
        pricePrediction: pricePredictionPda,
        creator: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log(`\nTransaction: ${tx}`);
    console.log(`\nPrice prediction created!`);
    console.log(`Bet ID: ${gameCount.toString()}`);
    console.log(`\nOthers can take the opposite side with:`);
    console.log(`npx ts-node scripts/price-take.ts ${pricePredictionPda.toString()}`);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

main();
