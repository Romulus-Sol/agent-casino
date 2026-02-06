/**
 * Example: Analyst Agent
 * 
 * An agent that analyzes game history before making betting decisions.
 * Demonstrates how agents can use on-chain data for strategy.
 * 
 * Run with: npx ts-node examples/analyst-agent.ts
 */

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { AgentCasino, GameRecord, HouseStats, AgentStats } from '../sdk/src';
import { loadWallet } from '../scripts/utils/wallet';

const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';

interface Analysis {
  totalGames: number;
  headsWinRate: number;
  tailsWinRate: number;
  avgPayout: number;
  houseRealizedEdge: number;
  topAgents: string[];
  recommendation: 'heads' | 'tails' | 'skip';
  confidence: number;
}

function analyzeGameHistory(records: GameRecord[]): Analysis {
  const coinFlips = records.filter(r => r.gameType === 'CoinFlip');
  
  if (coinFlips.length === 0) {
    return {
      totalGames: 0,
      headsWinRate: 50,
      tailsWinRate: 50,
      avgPayout: 0,
      houseRealizedEdge: 0,
      topAgents: [],
      recommendation: 'heads',
      confidence: 0,
    };
  }
  
  // Calculate win rates for each choice
  const headsGames = coinFlips.filter(r => r.choice === 0);
  const tailsGames = coinFlips.filter(r => r.choice === 1);
  
  const headsWins = headsGames.filter(r => r.payout > 0).length;
  const tailsWins = tailsGames.filter(r => r.payout > 0).length;
  
  const headsWinRate = headsGames.length > 0 ? (headsWins / headsGames.length) * 100 : 50;
  const tailsWinRate = tailsGames.length > 0 ? (tailsWins / tailsGames.length) * 100 : 50;
  
  // Calculate average payout
  const totalWagered = coinFlips.reduce((sum, r) => sum + r.amount, 0);
  const totalPaid = coinFlips.reduce((sum, r) => sum + r.payout, 0);
  const avgPayout = totalPaid / coinFlips.length;
  
  // Calculate realized house edge
  const houseRealizedEdge = ((totalWagered - totalPaid) / totalWagered) * 100;
  
  // Find top agents by volume
  const agentVolume = new Map<string, number>();
  coinFlips.forEach(r => {
    const current = agentVolume.get(r.player) || 0;
    agentVolume.set(r.player, current + r.amount);
  });
  
  const topAgents = Array.from(agentVolume.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([addr]) => addr.slice(0, 8) + '...');
  
  // Make recommendation (this is for demo - real agents might use ML)
  let recommendation: 'heads' | 'tails' | 'skip' = 'heads';
  let confidence = 0;
  
  if (coinFlips.length >= 100) {
    // With enough data, check for any statistical anomaly
    // (There shouldn't be one in a fair game, but agents might look)
    const diff = Math.abs(headsWinRate - tailsWinRate);
    
    if (diff > 5) {
      // Slight bias detected (likely just variance)
      recommendation = headsWinRate > tailsWinRate ? 'heads' : 'tails';
      confidence = Math.min(diff * 2, 30); // Low confidence - it's probably just variance
    } else {
      confidence = 50; // Fair game, pick randomly
    }
  } else {
    recommendation = 'heads';
    confidence = 10; // Not enough data
  }
  
  return {
    totalGames: coinFlips.length,
    headsWinRate,
    tailsWinRate,
    avgPayout,
    houseRealizedEdge,
    topAgents,
    recommendation,
    confidence,
  };
}

async function printHouseAnalysis(stats: HouseStats): Promise<void> {
  console.log('\n🏛️ HOUSE ANALYSIS');
  console.log('═'.repeat(50));
  
  const theoreticalEdge = stats.houseEdgeBps / 100;
  const realizedEdge = stats.totalVolume > 0 
    ? ((stats.totalVolume - stats.totalPayout) / stats.totalVolume) * 100 
    : 0;
  
  console.log(`Pool Size:        ${stats.pool.toFixed(4)} SOL`);
  console.log(`Min Bet:          ${stats.minBet} SOL`);
  console.log(`Max Bet:          ${stats.maxBet.toFixed(4)} SOL`);
  console.log(`Total Volume:     ${stats.totalVolume.toFixed(4)} SOL`);
  console.log(`Total Payout:     ${stats.totalPayout.toFixed(4)} SOL`);
  console.log(`House Profit:     ${stats.houseProfit.toFixed(4)} SOL`);
  console.log(`Theoretical Edge: ${theoreticalEdge.toFixed(2)}%`);
  console.log(`Realized Edge:    ${realizedEdge.toFixed(2)}%`);
  console.log(`Total Games:      ${stats.totalGames}`);
  
  // Edge analysis
  if (stats.totalGames > 100) {
    const edgeDiff = realizedEdge - theoreticalEdge;
    if (Math.abs(edgeDiff) > 2) {
      console.log(`\n⚠️ Edge deviation: ${edgeDiff > 0 ? '+' : ''}${edgeDiff.toFixed(2)}%`);
      console.log(`   This ${edgeDiff > 0 ? 'favors the house' : 'favors players'} vs theoretical`);
    } else {
      console.log(`\n✅ Edge within expected variance`);
    }
  }
}

async function printGameAnalysis(analysis: Analysis): Promise<void> {
  console.log('\n🎲 GAME ANALYSIS');
  console.log('═'.repeat(50));
  
  console.log(`Games Analyzed:   ${analysis.totalGames}`);
  console.log(`Heads Win Rate:   ${analysis.headsWinRate.toFixed(1)}%`);
  console.log(`Tails Win Rate:   ${analysis.tailsWinRate.toFixed(1)}%`);
  console.log(`Avg Payout:       ${analysis.avgPayout.toFixed(4)} SOL`);
  console.log(`House Real Edge:  ${analysis.houseRealizedEdge.toFixed(2)}%`);
  
  if (analysis.topAgents.length > 0) {
    console.log(`\n🤖 Top Agents by Volume:`);
    analysis.topAgents.forEach((agent, i) => {
      console.log(`   ${i + 1}. ${agent}`);
    });
  }
  
  console.log(`\n📊 RECOMMENDATION`);
  console.log(`═`.repeat(50));
  console.log(`Suggestion:       ${analysis.recommendation.toUpperCase()}`);
  console.log(`Confidence:       ${analysis.confidence}%`);
  
  if (analysis.confidence < 20) {
    console.log(`\n⚠️ Low confidence - insufficient data or truly fair game`);
  } else if (analysis.confidence < 50) {
    console.log(`\n⚠️ Medium confidence - proceed with caution`);
  } else {
    console.log(`\n✅ High confidence in recommendation`);
  }
}

async function main() {
  console.log('🔬 Analyst Agent starting up...\n');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const { keypair: wallet } = loadWallet();
  const casino = new AgentCasino(connection, wallet);
  
  console.log(`📍 Wallet: ${wallet.publicKey.toString()}`);
  
  // Get house stats
  let houseStats: HouseStats;
  try {
    houseStats = await casino.getHouseStats();
    await printHouseAnalysis(houseStats);
  } catch (e) {
    console.log('❌ Could not fetch house stats - house may not be initialized');
    return;
  }
  
  // Get game history
  console.log('\n📚 Fetching game history...');
  try {
    const history = await casino.getGameHistory(500);
    console.log(`   Found ${history.length} games`);
    
    const analysis = analyzeGameHistory(history);
    await printGameAnalysis(analysis);
    
    // Print recent games
    if (history.length > 0) {
      console.log('\n📜 RECENT GAMES');
      console.log('═'.repeat(50));
      console.log('Type      | Amount   | Choice | Result | Payout');
      console.log('-'.repeat(50));
      
      history.slice(-10).forEach(game => {
        const choiceStr = game.gameType === 'CoinFlip' 
          ? (game.choice === 0 ? 'Heads' : 'Tails')
          : game.choice.toString();
        const resultStr = game.gameType === 'CoinFlip'
          ? (game.result === 0 ? 'Heads' : 'Tails')
          : game.result.toString();
        const won = game.payout > 0 ? '✅' : '❌';
        
        console.log(
          `${game.gameType.padEnd(9)} | ${game.amount.toFixed(4).padStart(8)} | ${choiceStr.padEnd(6)} | ${resultStr.padEnd(6)} | ${won} ${game.payout.toFixed(4)}`
        );
      });
    }
    
  } catch (e: any) {
    console.log(`❌ Could not fetch game history: ${e.message}`);
  }
  
  // Get own stats
  console.log('\n🤖 MY STATS');
  console.log('═'.repeat(50));
  try {
    const myStats = await casino.getMyStats();
    console.log(`Total Games:   ${myStats.totalGames}`);
    console.log(`Total Wagered: ${myStats.totalWagered.toFixed(4)} SOL`);
    console.log(`Total Won:     ${myStats.totalWon.toFixed(4)} SOL`);
    console.log(`Win Rate:      ${myStats.winRate.toFixed(1)}%`);
    console.log(`Profit:        ${myStats.profit >= 0 ? '+' : ''}${myStats.profit.toFixed(4)} SOL`);
    console.log(`ROI:           ${myStats.roi >= 0 ? '+' : ''}${myStats.roi.toFixed(2)}%`);
  } catch (e) {
    console.log('No games played yet');
  }
  
  console.log('\n' + '═'.repeat(50));
  console.log('Analysis complete. Use this data to inform betting strategy.');
}

main().catch(console.error);
