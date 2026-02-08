import { Connection, PublicKey, clusterApiUrl, Transaction } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import * as sb from "@switchboard-xyz/on-demand";
import { loadWallet } from "../scripts/utils/wallet";

const { keypair } = loadWallet();

async function main() {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const sbIdl = await anchor.Program.fetchIdl(sb.ON_DEMAND_DEVNET_PID, provider);
  const sbProgram = new anchor.Program(sbIdl!, provider);

  // Create + commit
  const [rngAccount, rngKeypair, ixs] = await sb.Randomness.createAndCommitIxs(
    sbProgram as any, sb.ON_DEMAND_DEVNET_QUEUE, keypair.publicKey);
  const createTx = new Transaction();
  for (const ix of ixs) createTx.add(ix);
  await provider.sendAndConfirm(createTx, [keypair, rngKeypair]);
  console.log("Created:", rngAccount.pubkey.toString());

  // Reveal
  await new Promise(r => setTimeout(r, 4000));
  const revealIx = await rngAccount.revealIx(keypair.publicKey);
  const revealTx = new Transaction().add(revealIx);
  await provider.sendAndConfirm(revealTx, [keypair]);
  console.log("Revealed");

  // Check data fields
  const data = await rngAccount.loadData();
  console.log("seedSlot:", Number(data.seedSlot));
  console.log("revealSlot:", data.revealSlot ? Number(data.revealSlot) : "N/A");
  console.log("All data keys:", Object.keys(data).join(", "));

  const slot = await connection.getSlot();
  console.log("Current slot:", slot);
  console.log("Slot diff (current - seedSlot):", slot - Number(data.seedSlot));
}
main().catch(e => { console.error(e.message); process.exit(1); });
