/**
 * Quick test: create Switchboard randomness on devnet
 */
import { Connection, Keypair, PublicKey, clusterApiUrl, Transaction } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import * as sb from "@switchboard-xyz/on-demand";
import { loadWallet } from "../scripts/utils/wallet";

const { keypair } = loadWallet();

async function main() {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // Load Switchboard program
  const sbProgramId = sb.ON_DEMAND_DEVNET_PID;
  const sbIdl = await anchor.Program.fetchIdl(sbProgramId, provider);
  if (!sbIdl) throw new Error("Could not fetch Switchboard IDL");
  const sbProgram = new anchor.Program(sbIdl, provider);
  console.log("Switchboard program loaded");

  // Create randomness account + commit (returns [account, keypair, instructions[]])
  console.log("Creating randomness account...");
  const [randomnessAccount, rngKeypair, ixs] = await sb.Randomness.createAndCommitIxs(
    sbProgram as any,
    sb.ON_DEMAND_DEVNET_QUEUE,
    keypair.publicKey,
  );

  console.log("Randomness pubkey:", randomnessAccount.pubkey.toString());
  console.log("Instructions:", ixs.length);

  // Send create+commit tx
  const tx = new Transaction();
  for (const ix of ixs) {
    tx.add(ix);
  }

  const sig = await provider.sendAndConfirm(tx, [keypair, rngKeypair]);
  console.log("TX:", sig);

  // Wait for oracle to reveal
  console.log("Waiting for reveal...");
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const data = await randomnessAccount.loadData();
      console.log(`  ${i+1}: seedSlot=${data.seedSlot}`);
      if (data.seedSlot > 0) {
        console.log("Revealed!");
        break;
      }
    } catch (e: any) {
      console.log(`  ${i+1}: ${e.message?.slice(0, 80)}`);
    }
  }
  console.log("Done. Randomness account:", randomnessAccount.pubkey.toString());
}

main().catch(err => {
  console.error("Error:", err.message);
  console.error(err.stack?.slice(0, 500));
  process.exit(1);
});
