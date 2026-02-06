/**
 * Swap any SPL token to SOL via Jupiter and play a casino game.
 *
 * Usage:
 *   npx ts-node scripts/swap-and-play.ts coinflip <MINT> <AMOUNT> <heads|tails>
 *   npx ts-node scripts/swap-and-play.ts diceroll <MINT> <AMOUNT> <target 1-5>
 *   npx ts-node scripts/swap-and-play.ts limbo <MINT> <AMOUNT> <multiplier>
 *   npx ts-node scripts/swap-and-play.ts crash <MINT> <AMOUNT> <multiplier>
 *
 * Example (devnet mock):
 *   npx ts-node scripts/swap-and-play.ts coinflip EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 1000000 heads
 */

import { Connection } from '@solana/web3.js';
import { AgentCasino } from '../sdk/src';
import { loadWallet } from './utils/wallet';

const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';

async function main() {
  const [game, mint, amountStr, param] = process.argv.slice(2);
  if (!game || !mint || !amountStr || !param) {
    console.log('Usage: npx ts-node scripts/swap-and-play.ts <game> <mint> <amount> <param>');
    console.log('Games: coinflip, diceroll, limbo, crash');
    process.exit(1);
  }

  const amount = parseInt(amountStr);
  const { keypair } = loadWallet();
  const connection = new Connection(RPC_URL, 'confirmed');
  const casino = new AgentCasino(connection, keypair);

  console.log(`Swapping ${amount} tokens (${mint}) to SOL via Jupiter...`);

  let result;
  switch (game) {
    case 'coinflip':
      result = await casino.swapAndCoinFlip(mint, amount, param as 'heads' | 'tails');
      break;
    case 'diceroll':
      result = await casino.swapAndDiceRoll(mint, amount, parseInt(param) as any);
      break;
    case 'limbo':
      result = await casino.swapAndLimbo(mint, amount, parseFloat(param));
      break;
    case 'crash':
      result = await casino.swapAndCrash(mint, amount, parseFloat(param));
      break;
    default:
      console.log(`Unknown game: ${game}`);
      process.exit(1);
  }

  console.log('\n--- Swap Result ---');
  console.log(`  Mock: ${result.swap.mock}`);
  console.log(`  SOL received: ${result.swap.solAmount}`);
  console.log(`  Swap tx: ${result.swap.signature}`);
  console.log('\n--- Game Result ---');
  console.log(`  Game: ${game}`);
  console.log(`  Won: ${result.won}`);
  console.log(`  Payout: ${result.payout} SOL`);
  console.log(`  Tx: ${result.txSignature}`);
}

main().catch(console.error);
