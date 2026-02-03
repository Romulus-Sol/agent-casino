/**
 * Example: Degen Agent
 * 
 * A simple agent that plays coin flips with a martingale strategy.
 * This is for demonstration purposes - martingale will eventually lose!
 * 
 * Run with: npx ts-node examples/degen-agent.ts
 */

import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { AgentCasino, CoinChoice, GameResult } from '../sdk/src';
import * as fs from 'fs';

// Configuration
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const WALLET_PATH = process.env.WALLET_PATH || '~/.config/solana/id.json';
const INITIAL_BET = 0.01; // SOL
const MAX_BET = 1.0; // SOL
const SESSIONS = 10; // Number of betting sessions
const TARGET_PROFIT = 0.05; // SOL - stop when reached

interface AgentState {
  currentBet: number;
  totalProfit: number;
  wins: number;
  losses: number;
  streak: number; // negative for losses, positive for wins
  history: GameResult[];
}

async function loadWallet(): Promise<Keypair> {
  const walletPath = WALLET_PATH.replace('~', process.env.HOME || '');
  const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

function chooseNext(state: AgentState): CoinChoice {
  // Simple strategy: always bet the same side
  // Real agents might analyze history or use ML
  return 'heads';
}

function calculateNextBet(state: AgentState): number {
  // Martingale: double after loss, reset after win
  if (state.streak < 0) {
    const multiplier = Math.pow(2, Math.abs(state.streak));
    return Math.min(INITIAL_BET * multiplier, MAX_BET);
  }
  return INITIAL_BET;
}

async function runSession(casino: AgentCasino, state: AgentState): Promise<void> {
  const bet = calculateNextBet(state);
  const choice = chooseNext(state);
  
  console.log(`\n🎰 Betting ${bet} SOL on ${choice}...`);
  
  try {
    const result = await casino.coinFlip(bet, choice);
    state.history.push(result);
    
    if (result.won) {
      const profit = result.payout - bet;
      state.totalProfit += profit;
      state.wins++;
      state.streak = state.streak > 0 ? state.streak + 1 : 1;
      console.log(`✅ WON! Payout: ${result.payout} SOL (+${profit.toFixed(4)} SOL)`);
    } else {
      state.totalProfit -= bet;
      state.losses++;
      state.streak = state.streak < 0 ? state.streak - 1 : -1;
      console.log(`❌ LOST! -${bet} SOL`);
    }
    
    console.log(`📊 Running total: ${state.totalProfit.toFixed(4)} SOL | W/L: ${state.wins}/${state.losses} | Streak: ${state.streak}`);
    console.log(`🔐 Verify: tx=${result.txSignature.slice(0, 16)}... | seed=${result.serverSeed.slice(0, 16)}...`);
    
  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
  }
}

async function main() {
  console.log('🤖 Degen Agent starting up...\n');
  
  // Setup
  const connection = new Connection(RPC_URL, 'confirmed');
  const wallet = await loadWallet();
  const casino = new AgentCasino(connection, wallet);
  
  console.log(`📍 Wallet: ${wallet.publicKey.toString()}`);
  
  // Check balance
  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`💰 Balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  
  if (balance < INITIAL_BET * LAMPORTS_PER_SOL) {
    console.error('❌ Insufficient balance!');
    return;
  }
  
  // Get house stats
  try {
    const stats = await casino.getHouseStats();
    console.log(`\n🏛️ House Stats:`);
    console.log(`   Pool: ${stats.pool.toFixed(2)} SOL`);
    console.log(`   Edge: ${stats.houseEdgeBps / 100}%`);
    console.log(`   Min/Max bet: ${stats.minBet}/${stats.maxBet} SOL`);
    console.log(`   Total games: ${stats.totalGames}`);
  } catch (e) {
    console.log('⚠️ Could not fetch house stats (house may not be initialized)');
  }
  
  // Initialize state
  const state: AgentState = {
    currentBet: INITIAL_BET,
    totalProfit: 0,
    wins: 0,
    losses: 0,
    streak: 0,
    history: [],
  };
  
  // Run sessions
  console.log(`\n🎲 Starting ${SESSIONS} betting sessions...`);
  console.log(`   Initial bet: ${INITIAL_BET} SOL`);
  console.log(`   Max bet: ${MAX_BET} SOL`);
  console.log(`   Target profit: ${TARGET_PROFIT} SOL\n`);
  
  for (let i = 0; i < SESSIONS; i++) {
    // Check stop conditions
    if (state.totalProfit >= TARGET_PROFIT) {
      console.log(`\n🎉 Target profit reached! Stopping.`);
      break;
    }
    
    await runSession(casino, state);
    
    // Small delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // Final stats
  console.log(`\n${'='.repeat(50)}`);
  console.log(`📈 FINAL RESULTS`);
  console.log(`${'='.repeat(50)}`);
  console.log(`Total profit: ${state.totalProfit.toFixed(4)} SOL`);
  console.log(`Win rate: ${((state.wins / (state.wins + state.losses)) * 100).toFixed(1)}%`);
  console.log(`Games played: ${state.wins + state.losses}`);
  
  // Get updated agent stats
  try {
    const myStats = await casino.getMyStats();
    console.log(`\n🤖 All-time Agent Stats:`);
    console.log(`   Total games: ${myStats.totalGames}`);
    console.log(`   Total wagered: ${myStats.totalWagered.toFixed(2)} SOL`);
    console.log(`   Total won: ${myStats.totalWon.toFixed(2)} SOL`);
    console.log(`   ROI: ${myStats.roi.toFixed(2)}%`);
  } catch (e) {
    // Stats might not exist yet
  }
}

main().catch(console.error);
