/**
 * Settle a price prediction using Pyth oracle
 * Usage: npx ts-node scripts/price-settle.ts <prediction_address>
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

// Pyth devnet price feed addresses
const PYTH_FEEDS: Record<string, PublicKey> = {
  btc: new PublicKey("HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J"),
  sol: new PublicKey("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"),
  eth: new PublicKey("EdVCmQ9FSPcVe5YySXDPCRmc8aDQLKJ9xvYBMZPie1Vw"),
};

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: npx ts-node scripts/price-settle.ts <prediction_address>");
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

  const assetName = Object.keys(prediction.asset)[0];
  const directionName = Object.keys(prediction.direction)[0];
  const targetPrice = prediction.targetPrice.toNumber() / 1e8;
  const betAmount = prediction.betAmount.toNumber() / LAMPORTS_PER_SOL;
  const expiryTime = new Date(prediction.expiryTime.toNumber() * 1000);
  const now = new Date();

  console.log("\n=== Price Prediction Details ===");
  console.log(`Asset: ${assetName.toUpperCase()}`);
  console.log(`Target: ${assetName.toUpperCase()} ${directionName} $${targetPrice}`);
  console.log(`Pool: ${betAmount * 2} SOL`);
  console.log(`Expires: ${expiryTime.toISOString()}`);
  console.log(`Status: ${Object.keys(prediction.status)[0]}`);

  if (prediction.status.matched === undefined) {
    console.error("\nThis prediction is not matched (both sides filled)!");
    if (prediction.status.open !== undefined) {
      console.log("Prediction is still open - waiting for someone to take the other side.");
    }
    process.exit(1);
  }

  if (now < expiryTime) {
    const remaining = Math.ceil((expiryTime.getTime() - now.getTime()) / 1000 / 60);
    console.error(`\nCannot settle yet! ${remaining} minutes remaining.`);
    process.exit(1);
  }

  // Get Pyth price feed
  const pythFeed = PYTH_FEEDS[assetName];
  console.log(`\nPyth Feed: ${pythFeed.toString()}`);

  console.log("\nSettling prediction...");

  try {
    const tx = await (program.methods as any)
      .settlePricePrediction()
      .accounts({
        house: housePda,
        pricePrediction: predictionAddress,
        priceFeed: pythFeed,
        creator: prediction.creator,
        taker: prediction.taker,
        settler: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log(`\nTransaction: ${tx}`);

    // Fetch updated prediction
    const updatedPrediction = await (program.account as any).pricePrediction.fetch(predictionAddress);
    const settledPrice = updatedPrediction.settledPrice.toNumber() / 1e8;
    const winner = updatedPrediction.winner.toString();

    console.log(`\n=== Settlement Complete ===`);
    console.log(`Settled Price: $${settledPrice}`);
    console.log(`Target Price: $${targetPrice}`);
    console.log(`Direction: ${directionName}`);
    console.log(`Winner: ${winner}`);

    if (winner === prediction.creator.toString()) {
      console.log(`Creator wins! (Price was ${directionName} target)`);
    } else {
      console.log(`Taker wins! (Price was NOT ${directionName} target)`);
    }
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

main();
