/**
 * Test: create (no commit) → request → commitAndReveal(settle)
 */
import { Connection, PublicKey, clusterApiUrl, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import * as sb from "@switchboard-xyz/on-demand";
import { AgentCasino } from "../sdk/src";
import { loadWallet } from "../scripts/utils/wallet";

const { keypair } = loadWallet();
const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const sbIdl = await anchor.Program.fetchIdl(sb.ON_DEMAND_DEVNET_PID, provider);
  const sbProgram = new anchor.Program(sbIdl!, provider);
  const casino = new AgentCasino(connection, keypair);
  await casino.loadProgram();
  const program = (casino as any).program;
  const housePda = (casino as any).housePda;

  // Step 1: Create randomness account (NO commit)
  console.log("Step 1: Creating randomness account (no commit)...");
  const rngKeypair = anchor.web3.Keypair.generate();
  const [rngAccount, createIx] = await sb.Randomness.create(
    sbProgram as any, rngKeypair, sb.ON_DEMAND_DEVNET_QUEUE, keypair.publicKey);
  const createTx = new Transaction().add(createIx);
  await provider.sendAndConfirm(createTx, [keypair, rngKeypair]);
  console.log("  Randomness:", rngAccount.pubkey.toString());

  // Step 2: VRF request (locks bet, records randomness account)
  console.log("Step 2: VRF coin flip request...");
  const houseAccount = await program.account.house.fetch(housePda);
  const amount = new anchor.BN(0.001 * LAMPORTS_PER_SOL);
  const [vrfRequestPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vrf_request"), keypair.publicKey.toBuffer(),
     houseAccount.totalGames.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID);

  await program.methods.vrfCoinFlipRequest(amount, 0)
    .accounts({
      house: housePda,
      vrfRequest: vrfRequestPda,
      randomnessAccount: rngAccount.pubkey,
      player: keypair.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).rpc();
  console.log("  VRF Request:", vrfRequestPda.toString());

  // Step 3: Build settle instruction
  const [agentStatsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), keypair.publicKey.toBuffer()], PROGRAM_ID);
  const settleIx = await program.methods.vrfCoinFlipSettle()
    .accounts({
      house: housePda,
      vrfRequest: vrfRequestPda,
      agentStats: agentStatsPda,
      randomnessAccount: rngAccount.pubkey,
      player: keypair.publicKey,
      settler: keypair.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).instruction();

  // Step 4: commitAndReveal (commit + reveal + settle all handled by SDK)
  console.log("Step 3: commitAndReveal (with settle callback)...");
  await rngAccount.commitAndReveal(
    [settleIx],
    [keypair],
    sb.ON_DEMAND_DEVNET_QUEUE,
    { computeUnitPrice: 75000, computeUnitLimit: 300000 },
    true,
  );

  // Step 5: Read result
  const settled = await program.account.vrfRequest.fetch(vrfRequestPda);
  const payout = settled.payout.toNumber() / LAMPORTS_PER_SOL;
  console.log("Won:", payout > 0, "Payout:", payout, "Result:", settled.result);
  console.log("SUCCESS!");
}

main().catch(e => { console.error("Error:", e.message?.slice(0, 300)); process.exit(1); });
