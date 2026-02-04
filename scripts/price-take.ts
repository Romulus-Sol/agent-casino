/**
 * Take the opposite side of a price prediction
 * Usage: npx ts-node scripts/price-take.ts <prediction_address>
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: npx ts-node scripts/price-take.ts <prediction_address>");
    process.exit(1);
  }

  const predictionAddress = new PublicKey(args[0]);

  // Setup connection
  const connection = new anchor.web3.Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );

  // Load wallet
  const walletPath = `${os.homedir()}/.config/solana/id.json`;
  const walletKeypair = anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  const wallet = new anchor.Wallet(walletKeypair);

  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const idl = JSON.parse(fs.readFileSync("./target/idl/agent_casino.json", "utf-8"));
  const program = new Program(idl, provider);

  const [housePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("house")],
    PROGRAM_ID
  );

  // Fetch prediction details
  const prediction = await (program.account as any).pricePrediction.fetch(predictionAddress);

  const assetName = Object.keys(prediction.asset)[0].toUpperCase();
  const directionName = Object.keys(prediction.direction)[0];
  const targetPrice = prediction.targetPrice.toNumber() / 1e8;
  const betAmount = prediction.betAmount.toNumber() / LAMPORTS_PER_SOL;
  const expiryTime = new Date(prediction.expiryTime.toNumber() * 1000);

  console.log("\n=== Price Prediction Details ===");
  console.log(`Asset: ${assetName}`);
  console.log(`Creator bets: ${assetName} will be ${directionName} $${targetPrice}`);
  console.log(`You would bet: ${assetName} will be ${directionName === 'above' ? 'below' : 'above'} $${targetPrice}`);
  console.log(`Bet Amount: ${betAmount} SOL each (${betAmount * 2} SOL total pool)`);
  console.log(`Expires: ${expiryTime.toISOString()}`);

  if (prediction.status.open === undefined) {
    console.error("\nThis prediction is not open for taking!");
    process.exit(1);
  }

  console.log("\nTaking opposite side...");

  try {
    const tx = await (program.methods as any)
      .takePricePrediction()
      .accounts({
        house: housePda,
        pricePrediction: predictionAddress,
        taker: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log(`\nTransaction: ${tx}`);
    console.log(`\nBet taken! You bet ${assetName} will be ${directionName === 'above' ? 'BELOW' : 'ABOVE'} $${targetPrice}`);
    console.log(`\nAfter expiry, anyone can settle with:`);
    console.log(`npx ts-node scripts/price-settle.ts ${predictionAddress.toString()}`);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

main();
