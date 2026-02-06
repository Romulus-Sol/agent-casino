/**
 * Quick Play - Your first Agent Casino game
 *
 * Run: npx ts-node examples/quick-play.ts
 */

import { Connection } from '@solana/web3.js';
import { AgentCasino } from '../sdk/src';
import { loadWallet } from '../scripts/utils/wallet';

async function main() {
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const { keypair, address } = loadWallet();
  const casino = new AgentCasino(connection, keypair);

  console.log(`Wallet: ${address}`);

  // Check the house
  const house = await casino.getHouseStats();
  console.log(`House pool: ${house.pool} SOL | Games played: ${house.totalGames}\n`);

  // Flip a coin
  const choice = Math.random() > 0.5 ? 'heads' : 'tails';
  console.log(`Betting 0.001 SOL on ${choice}...`);

  const result = await casino.coinFlip(0.001, choice as 'heads' | 'tails');

  if (result.won) {
    console.log(`Won ${result.payout} SOL!`);
  } else {
    console.log('Lost 0.001 SOL');
  }

  // Check your stats
  const stats = await casino.getMyStats();
  console.log(`\nYour record: ${stats.wins}W / ${stats.losses}L`);
}

main().catch(console.error);
