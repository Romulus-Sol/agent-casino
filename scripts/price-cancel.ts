import { loadWallet } from "./utils/wallet";
/**
 * Cancel expired/unmatched price predictions
 * Usage: npx ts-node scripts/price-cancel.ts <prediction_address> [<address2> ...]
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: npx ts-node scripts/price-cancel.ts <prediction_address> [<address2> ...]");
    process.exit(1);
  }

  const connection = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
  const { keypair: walletKeypair } = loadWallet();
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });

  const idl = JSON.parse(fs.readFileSync("./target/idl/agent_casino.json", "utf-8"));
  const program = new Program(idl, provider);

  const [housePda] = PublicKey.findProgramAddressSync([Buffer.from("house")], PROGRAM_ID);

  for (const addr of args) {
    const predictionPda = new PublicKey(addr);
    try {
      const prediction = await (program.account as any).pricePrediction.fetch(predictionPda);
      const status = Object.keys(prediction.status)[0];
      console.log(`\nCancelling prediction ${addr.slice(0, 8)}... (status: ${status})`);

      const tx = await (program.methods as any)
        .cancelPricePrediction()
        .accounts({
          house: housePda,
          pricePrediction: predictionPda,
          creator: wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log(`  Cancelled! TX: ${tx}`);
    } catch (err: any) {
      console.error(`  Error cancelling ${addr.slice(0, 8)}...: ${err.message}`);
    }
  }
}

main();
