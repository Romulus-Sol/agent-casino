/**
 * Test: correct VRF flow — create → request → commit → reveal → settle
 */
import { Connection, PublicKey, clusterApiUrl, Transaction } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import * as sb from "@switchboard-xyz/on-demand";
import { AgentCasino } from "../sdk/src";
import { loadWallet } from "../scripts/utils/wallet";

const { keypair } = loadWallet();

async function main() {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const sbIdl = await anchor.Program.fetchIdl(sb.ON_DEMAND_DEVNET_PID, provider);
  const sbProgram = new anchor.Program(sbIdl!, provider);
  const casino = new AgentCasino(connection, keypair);

  // Step 1: Create randomness account (without commit)
  console.log("Step 1: Creating randomness account...");
  const rngKeypair = anchor.web3.Keypair.generate();
  const [rngAccount, createIx] = await sb.Randomness.create(
    sbProgram as any, rngKeypair, sb.ON_DEMAND_DEVNET_QUEUE, keypair.publicKey);
  const createTx = new Transaction().add(createIx);
  await provider.sendAndConfirm(createTx, [keypair, rngKeypair]);
  console.log("  Created:", rngAccount.pubkey.toString());

  // Step 2: Call VRF request (locks bet + records randomness account)
  console.log("Step 2: VRF coin flip request...");
  const { vrfRequestAddress } = await casino.vrfCoinFlipRequest(0.001, "heads", rngAccount.pubkey.toString());
  console.log("  VRF Request:", vrfRequestAddress);

  // Step 3: Commit randomness (seedSlot will be AFTER request)
  console.log("Step 3: Committing randomness...");
  const commitIx = await rngAccount.commitIx(sb.ON_DEMAND_DEVNET_QUEUE, keypair.publicKey);
  const commitTx = new Transaction().add(commitIx);
  await provider.sendAndConfirm(commitTx, [keypair]);
  console.log("  Committed");

  // Step 4: Reveal
  console.log("Step 4: Waiting for oracle + revealing...");
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const revealIx = await rngAccount.revealIx(keypair.publicKey);
      const revealTx = new Transaction().add(revealIx);
      await provider.sendAndConfirm(revealTx, [keypair]);
      console.log("  Revealed on attempt", i + 1);
      break;
    } catch (e: any) {
      console.log("  Attempt", i + 1, ":", e.message?.slice(0, 60));
    }
  }

  // Step 5: Settle
  console.log("Step 5: Settling coin flip...");
  const result = await casino.vrfCoinFlipSettle(vrfRequestAddress, rngAccount.pubkey.toString());
  console.log("  Won:", result.won, "Payout:", result.payout, "TX:", result.tx.slice(0, 20) + "...");
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
