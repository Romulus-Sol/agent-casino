/**
 * Quick Play - Your first Agent Casino game
 *
 * Plays a single VRF coin flip on Solana devnet using Switchboard randomness.
 *
 * Run: npx ts-node examples/quick-play.ts
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, ComputeBudgetProgram, clusterApiUrl } from '@solana/web3.js';
import { AgentCasino } from '../sdk/src';
import { loadWallet } from '../scripts/utils/wallet';
import * as anchor from '@coral-xyz/anchor';
import * as sb from '@switchboard-xyz/on-demand';
import * as fs from 'fs';
import * as path from 'path';

const PROGRAM_ID = new PublicKey('5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV');

async function main() {
  const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
  const { keypair, address } = loadWallet();
  const casino = new AgentCasino(connection, keypair);

  console.log(`Wallet: ${address}`);

  // Check the house
  const house = await casino.getHouseStats();
  console.log(`House pool: ${house.pool.toFixed(2)} SOL | Games played: ${house.totalGames}\n`);

  // Setup Anchor + Switchboard
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  anchor.setProvider(provider);

  const sbIdl = await anchor.Program.fetchIdl(sb.ON_DEMAND_DEVNET_PID, provider);
  if (!sbIdl) throw new Error('Could not fetch Switchboard IDL');
  const sbProgram = new anchor.Program(sbIdl, provider);

  const idlPath = path.join(__dirname, '../target/idl/agent_casino.json');
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));
  const program = new anchor.Program(idl, provider) as any;

  const [housePda] = PublicKey.findProgramAddressSync([Buffer.from('house')], PROGRAM_ID);

  // Flip a coin using Switchboard VRF
  const choice = Math.random() > 0.5 ? 'heads' : 'tails';
  console.log(`Betting 0.001 SOL on ${choice}...`);

  // Step 1: Create VRF randomness account
  const rngKeypair = anchor.web3.Keypair.generate();
  const [rngAccount, createIx] = await sb.Randomness.create(
    sbProgram as any, rngKeypair, sb.ON_DEMAND_DEVNET_QUEUE, keypair.publicKey);
  await provider.sendAndConfirm(new Transaction().add(createIx), [keypair, rngKeypair]);

  // Step 2: VRF coin flip request
  const houseAccount = await program.account.house.fetch(housePda);
  const amount = new anchor.BN(0.001 * LAMPORTS_PER_SOL);
  const [vrfPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vrf_request'), keypair.publicKey.toBuffer(),
     (houseAccount as any).totalGames.toArrayLike(Buffer, 'le', 8)],
    PROGRAM_ID);

  await program.methods.vrfCoinFlipRequest(amount, choice === 'heads' ? 0 : 1)
    .accounts({
      house: housePda, vrfRequest: vrfPda,
      randomnessAccount: rngAccount.pubkey,
      player: keypair.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).rpc();

  // Step 3: Commit randomness
  const commitIx = await rngAccount.commitIx(sb.ON_DEMAND_DEVNET_QUEUE, keypair.publicKey);
  await provider.sendAndConfirm(new Transaction().add(commitIx), [keypair]);

  // Step 4: Wait for oracle, then reveal + settle in same TX
  const [agentStatsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('agent'), keypair.publicKey.toBuffer()], PROGRAM_ID);
  const settleIx = await program.methods.vrfCoinFlipSettle()
    .accounts({
      house: housePda, vrfRequest: vrfPda, agentStats: agentStatsPda,
      randomnessAccount: rngAccount.pubkey,
      player: keypair.publicKey, settler: keypair.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).instruction();

  console.log('Waiting for Switchboard VRF oracle...');
  const origLog = console.log; const origErr = console.error;
  let tx = '';
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 2500));
    try {
      console.log = () => {}; console.error = () => {};
      const revealIx = await Promise.race([
        rngAccount.revealIx(keypair.publicKey),
        new Promise((_, rej) => setTimeout(() => rej(new Error('revealIx timeout')), 10000)),
      ]) as any;
      console.log = origLog; console.error = origErr;
      tx = await provider.sendAndConfirm(
        new Transaction()
          .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 75000 }))
          .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }))
          .add(revealIx).add(settleIx),
        [keypair]);
      break;
    } catch {
      console.log = origLog; console.error = origErr;
      if (i === 11) throw new Error('VRF oracle unavailable after 12 retries');
    }
  }

  // Read result
  const settled = await program.account.vrfRequest.fetch(vrfPda);
  const payout = (settled as any).payout.toNumber() / LAMPORTS_PER_SOL;

  if (payout > 0) {
    console.log(`Won ${payout.toFixed(4)} SOL!`);
  } else {
    console.log('Lost 0.001 SOL');
  }
  console.log(`TX: ${tx}`);

  // Check your stats
  const stats = await casino.getMyStats();
  console.log(`\nYour record: ${stats.wins}W / ${stats.losses}L`);
}

main().catch(console.error);
