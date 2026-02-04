import { loadWallet, isAgentWalletConfigured } from "./utils/wallet";
/**
 * List all price predictions
 * Usage: npx ts-node scripts/price-list.ts [status]
 * Status: open, matched, settled, all (default: open)
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  const args = process.argv.slice(2);
  const statusFilter = args[0]?.toLowerCase() || "open";

  // Setup connection
  const connection = new anchor.web3.Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );

  // Load wallet
  // Load wallet (AgentWallet aware)
  const { keypair: walletKeypair } = loadWallet();
  const wallet = new anchor.Wallet(walletKeypair);

  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const idl = JSON.parse(fs.readFileSync("./target/idl/agent_casino.json", "utf-8"));
  const program = new Program(idl, provider);

  console.log(`\n=== Price Predictions (${statusFilter}) ===\n`);

  try {
    // Fetch all price prediction accounts
    const predictions = await (program.account as any).pricePrediction.all();

    if (predictions.length === 0) {
      console.log("No price predictions found.");
      return;
    }

    const now = Date.now() / 1000;
    let count = 0;

    for (const pred of predictions) {
      const account = pred.account;
      const status = Object.keys(account.status)[0];

      // Filter by status
      if (statusFilter !== "all" && status !== statusFilter) {
        continue;
      }

      count++;
      const asset = Object.keys(account.asset)[0].toUpperCase();
      const direction = Object.keys(account.direction)[0];
      const targetPrice = account.targetPrice.toNumber() / 1e8;
      const betAmount = account.betAmount.toNumber() / LAMPORTS_PER_SOL;
      const expiryTime = new Date(account.expiryTime.toNumber() * 1000);
      const isExpired = now >= account.expiryTime.toNumber();

      console.log(`--- Prediction #${account.betIndex} ---`);
      console.log(`Address: ${pred.publicKey.toString()}`);
      console.log(`Bet: ${asset} will be ${direction} $${targetPrice}`);
      console.log(`Amount: ${betAmount} SOL per side`);
      console.log(`Status: ${status}${isExpired && status === 'matched' ? ' (ready to settle)' : ''}`);
      console.log(`Expires: ${expiryTime.toISOString()}`);
      console.log(`Creator: ${account.creator.toString().slice(0, 8)}...`);

      if (status !== 'open') {
        console.log(`Taker: ${account.taker.toString().slice(0, 8)}...`);
      }

      if (status === 'settled') {
        const settledPrice = account.settledPrice.toNumber() / 1e8;
        console.log(`Settled Price: $${settledPrice}`);
        console.log(`Winner: ${account.winner.toString().slice(0, 8)}...`);
      }

      console.log("");
    }

    console.log(`Total: ${count} prediction(s)`);

  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

main();
