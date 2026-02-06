/**
 * Example: House Agent (Liquidity Provider)
 * 
 * An agent that provides liquidity to the casino pool and monitors returns.
 * This demonstrates how agents can be on both sides of the game.
 * 
 * Run with: npx ts-node examples/house-agent.ts
 */

import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { AgentCasino, HouseStats } from '../sdk/src';
import { loadWallet } from '../scripts/utils/wallet';

const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const LIQUIDITY_AMOUNT = 1.0; // SOL to provide
const MONITOR_INTERVAL = 30000; // 30 seconds

interface LpMetrics {
  timestamp: number;
  poolSize: number;
  totalVolume: number;
  houseProfit: number;
  realizedEdge: number;
  gamesPlayed: number;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

async function main() {
  console.log('🏦 House Agent starting up...\n');
  console.log('This agent provides liquidity to the casino pool and monitors returns.\n');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const { keypair: wallet } = loadWallet();
  const casino = new AgentCasino(connection, wallet);
  
  console.log(`📍 Wallet: ${wallet.publicKey.toString()}`);
  
  // Check balance
  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`💰 Balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  
  if (balance < LIQUIDITY_AMOUNT * LAMPORTS_PER_SOL) {
    console.error(`❌ Insufficient balance! Need at least ${LIQUIDITY_AMOUNT} SOL`);
    return;
  }
  
  // Check current house stats
  let initialStats: HouseStats;
  try {
    initialStats = await casino.getHouseStats();
    console.log('\n📊 Current House Stats:');
    console.log(`   Pool: ${initialStats.pool.toFixed(4)} SOL`);
    console.log(`   Games: ${initialStats.totalGames}`);
    console.log(`   Profit: ${initialStats.houseProfit.toFixed(4)} SOL`);
  } catch (e) {
    console.log('⚠️ House not initialized or cannot read stats');
    initialStats = {
      pool: 0,
      houseEdgeBps: 100,
      minBet: 0.001,
      maxBet: 0,
      totalGames: 0,
      totalVolume: 0,
      totalPayout: 0,
      houseProfit: 0,
    };
  }
  
  // Provide liquidity
  console.log(`\n💧 Adding ${LIQUIDITY_AMOUNT} SOL liquidity to the pool...`);
  
  try {
    const tx = await casino.addLiquidity(LIQUIDITY_AMOUNT);
    console.log(`✅ Liquidity added! TX: ${tx.slice(0, 16)}...`);
  } catch (e: any) {
    console.error(`❌ Failed to add liquidity: ${e.message}`);
    console.log('\nNote: If house is not initialized, the admin needs to call initialize_house first.');
    return;
  }
  
  // Track metrics over time
  const metrics: LpMetrics[] = [];
  const startTime = Date.now();
  let lastStats = initialStats;
  
  console.log('\n📈 Starting monitoring loop...');
  console.log(`   Interval: ${MONITOR_INTERVAL / 1000}s`);
  console.log('   Press Ctrl+C to stop\n');
  
  const monitor = async () => {
    try {
      const currentStats = await casino.getHouseStats();
      
      const metric: LpMetrics = {
        timestamp: Date.now(),
        poolSize: currentStats.pool,
        totalVolume: currentStats.totalVolume,
        houseProfit: currentStats.houseProfit,
        realizedEdge: currentStats.totalVolume > 0 
          ? (currentStats.houseProfit / currentStats.totalVolume) * 100 
          : 0,
        gamesPlayed: currentStats.totalGames,
      };
      metrics.push(metric);
      
      // Calculate changes since last check
      const volumeDelta = currentStats.totalVolume - lastStats.totalVolume;
      const profitDelta = currentStats.houseProfit - lastStats.houseProfit;
      const gamesDelta = currentStats.totalGames - lastStats.totalGames;
      
      // Print status
      const elapsed = formatDuration(Date.now() - startTime);
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`⏱️  ${new Date().toISOString()} | Running: ${elapsed}`);
      console.log(`${'─'.repeat(50)}`);
      console.log(`Pool Size:     ${currentStats.pool.toFixed(4)} SOL`);
      console.log(`Total Volume:  ${currentStats.totalVolume.toFixed(4)} SOL (+${volumeDelta.toFixed(4)})`);
      console.log(`House Profit:  ${currentStats.houseProfit.toFixed(4)} SOL (+${profitDelta.toFixed(4)})`);
      console.log(`Realized Edge: ${metric.realizedEdge.toFixed(2)}%`);
      console.log(`Games Played:  ${currentStats.totalGames} (+${gamesDelta})`);
      
      // Calculate LP returns (simplified - assumes we're the only LP)
      const poolGrowth = currentStats.pool - LIQUIDITY_AMOUNT;
      const lpReturn = (poolGrowth / LIQUIDITY_AMOUNT) * 100;
      console.log(`\n💰 LP Returns:`);
      console.log(`   Pool Growth:   ${poolGrowth >= 0 ? '+' : ''}${poolGrowth.toFixed(4)} SOL`);
      console.log(`   Return:        ${lpReturn >= 0 ? '+' : ''}${lpReturn.toFixed(2)}%`);
      
      // Risk metrics
      const maxBetRisk = currentStats.maxBet / currentStats.pool * 100;
      console.log(`\n⚠️ Risk Metrics:`);
      console.log(`   Max Bet:       ${currentStats.maxBet.toFixed(4)} SOL (${maxBetRisk.toFixed(1)}% of pool)`);
      console.log(`   Games/Volume:  ${(currentStats.totalGames / Math.max(currentStats.totalVolume, 0.001)).toFixed(2)} games/SOL`);
      
      // Hourly projection
      if (metrics.length >= 2) {
        const timeDiff = (metrics[metrics.length - 1].timestamp - metrics[0].timestamp) / 1000 / 60 / 60; // hours
        if (timeDiff > 0) {
          const profitPerHour = currentStats.houseProfit / timeDiff;
          console.log(`\n📊 Projections:`);
          console.log(`   Profit/Hour:   ${profitPerHour.toFixed(4)} SOL`);
          console.log(`   Profit/Day:    ${(profitPerHour * 24).toFixed(4)} SOL`);
        }
      }
      
      lastStats = currentStats;
      
    } catch (e: any) {
      console.error(`\n❌ Error fetching stats: ${e.message}`);
    }
  };
  
  // Run immediately then on interval
  await monitor();
  const intervalId = setInterval(monitor, MONITOR_INTERVAL);
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\n🛑 Shutting down...');
    clearInterval(intervalId);
    
    // Print summary
    if (metrics.length > 0) {
      const first = metrics[0];
      const last = metrics[metrics.length - 1];
      const duration = formatDuration(last.timestamp - first.timestamp);
      
      console.log('\n📊 SESSION SUMMARY');
      console.log('═'.repeat(50));
      console.log(`Duration:        ${duration}`);
      console.log(`Liquidity Added: ${LIQUIDITY_AMOUNT} SOL`);
      console.log(`Final Pool:      ${last.poolSize.toFixed(4)} SOL`);
      console.log(`Volume:          ${last.totalVolume.toFixed(4)} SOL`);
      console.log(`Profit:          ${last.houseProfit.toFixed(4)} SOL`);
      console.log(`Games:           ${last.gamesPlayed}`);
      console.log(`Avg Edge:        ${last.realizedEdge.toFixed(2)}%`);
      
      const poolReturn = ((last.poolSize - LIQUIDITY_AMOUNT) / LIQUIDITY_AMOUNT) * 100;
      console.log(`LP Return:       ${poolReturn >= 0 ? '+' : ''}${poolReturn.toFixed(2)}%`);
    }
    
    process.exit(0);
  });
}

main().catch(console.error);
