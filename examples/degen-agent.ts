/**
 * Example: Degen Agent
 *
 * A simple agent that plays coin flips with a martingale strategy.
 * Uses Switchboard VRF for provably fair randomness.
 * This is for demonstration purposes - martingale will eventually lose!
 *
 * Run with: npx ts-node examples/degen-agent.ts
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, ComputeBudgetProgram, clusterApiUrl } from '@solana/web3.js';
import { AgentCasino } from '../sdk/src';
import { loadWallet } from '../scripts/utils/wallet';
import * as anchor from '@coral-xyz/anchor';
import * as sb from '@switchboard-xyz/on-demand';
import * as fs from 'fs';
import * as path from 'path';

const PROGRAM_ID = new PublicKey('5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV');

// Configuration
const INITIAL_BET = 0.001; // SOL
const MAX_BET = 0.01; // SOL
const SESSIONS = 5; // Number of betting sessions
const TARGET_PROFIT = 0.005; // SOL - stop when reached

interface AgentState {
  totalProfit: number;
  wins: number;
  losses: number;
  streak: number;
}

function calculateNextBet(state: AgentState): number {
  // Martingale: double after loss, reset after win
  if (state.streak < 0) {
    const multiplier = Math.pow(2, Math.abs(state.streak));
    return Math.min(INITIAL_BET * multiplier, MAX_BET);
  }
  return INITIAL_BET;
}

async function vrfCoinFlip(
  sbProgram: anchor.Program,
  program: anchor.Program,
  provider: anchor.AnchorProvider,
  housePda: PublicKey,
  keypair: anchor.web3.Keypair,
  amountSol: number,
  choice: 'heads' | 'tails',
): Promise<{ won: boolean; payout: number; tx: string }> {
  const rngKeypair = anchor.web3.Keypair.generate();
  const [rngAccount, createIx] = await sb.Randomness.create(
    sbProgram as any, rngKeypair, sb.ON_DEMAND_DEVNET_QUEUE, keypair.publicKey);
  await provider.sendAndConfirm(new Transaction().add(createIx), [keypair, rngKeypair]);

  const houseAccount = await program.account.house.fetch(housePda);
  const amount = new anchor.BN(amountSol * LAMPORTS_PER_SOL);
  const [vrfPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vrf_request'), keypair.publicKey.toBuffer(),
     (houseAccount as any).totalGames.toArrayLike(Buffer, 'le', 8)],
    PROGRAM_ID);

  await (program.methods as any).vrfCoinFlipRequest(amount, choice === 'heads' ? 0 : 1)
    .accounts({
      house: housePda, vrfRequest: vrfPda,
      randomnessAccount: rngAccount.pubkey,
      player: keypair.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).rpc();

  const commitIx = await rngAccount.commitIx(sb.ON_DEMAND_DEVNET_QUEUE, keypair.publicKey);
  await provider.sendAndConfirm(new Transaction().add(commitIx), [keypair]);

  const [agentStatsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('agent'), keypair.publicKey.toBuffer()], PROGRAM_ID);
  const settleIx = await (program.methods as any).vrfCoinFlipSettle()
    .accounts({
      house: housePda, vrfRequest: vrfPda, agentStats: agentStatsPda,
      randomnessAccount: rngAccount.pubkey,
      player: keypair.publicKey, settler: keypair.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).instruction();

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

  const settled = await program.account.vrfRequest.fetch(vrfPda);
  const payout = (settled as any).payout.toNumber() / LAMPORTS_PER_SOL;
  return { won: payout > 0, payout, tx };
}

async function main() {
  console.log('Degen Agent starting up...\n');

  const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
  const { keypair } = loadWallet();
  const casino = new AgentCasino(connection, keypair);
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

  console.log(`Wallet: ${keypair.publicKey.toString()}`);
  const balance = await connection.getBalance(keypair.publicKey);
  console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  const house = await casino.getHouseStats();
  console.log(`House pool: ${house.pool.toFixed(2)} SOL | Edge: ${house.houseEdgeBps / 100}%`);
  console.log(`\nStarting ${SESSIONS} sessions | Initial bet: ${INITIAL_BET} SOL | Max: ${MAX_BET} SOL | Target: +${TARGET_PROFIT} SOL\n`);

  const state: AgentState = { totalProfit: 0, wins: 0, losses: 0, streak: 0 };

  for (let i = 0; i < SESSIONS; i++) {
    if (state.totalProfit >= TARGET_PROFIT) {
      console.log(`\nTarget profit reached! Stopping.`);
      break;
    }

    const bet = calculateNextBet(state);
    process.stdout.write(`[${i + 1}/${SESSIONS}] ${bet} SOL on heads ... `);

    try {
      const result = await vrfCoinFlip(sbProgram, program, provider, housePda, keypair, bet, 'heads');
      if (result.won) {
        state.totalProfit += result.payout - bet;
        state.wins++;
        state.streak = state.streak > 0 ? state.streak + 1 : 1;
        console.log(`WIN +${(result.payout - bet).toFixed(4)} SOL  (total: ${state.totalProfit >= 0 ? '+' : ''}${state.totalProfit.toFixed(4)})`);
      } else {
        state.totalProfit -= bet;
        state.losses++;
        state.streak = state.streak < 0 ? state.streak - 1 : -1;
        console.log(`LOSS -${bet} SOL  (total: ${state.totalProfit >= 0 ? '+' : ''}${state.totalProfit.toFixed(4)})`);
      }
    } catch (e: any) {
      console.log(`ERROR: ${e.message.slice(0, 60)}`);
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`FINAL: ${state.totalProfit >= 0 ? '+' : ''}${state.totalProfit.toFixed(4)} SOL | ${state.wins}W/${state.losses}L`);

  try {
    const myStats = await casino.getMyStats();
    console.log(`All-time: ${myStats.totalGames} games, ${myStats.totalWagered.toFixed(4)} SOL wagered`);
  } catch { /* no stats yet */ }
}

main().catch(console.error);
