/**
 * Agent Casino x402 HTTP API
 *
 * Exposes casino games as HTTP endpoints with x402 USDC payment gating.
 * Any AI agent that understands x402 can play games without importing our SDK.
 *
 * Free endpoints:
 *   GET /v1/health          — Server health check
 *   GET /v1/stats           — House stats
 *
 * Paid endpoints (x402 gated):
 *   GET /v1/games/coinflip  — ?choice=heads|tails
 *   GET /v1/games/diceroll  — ?target=1-5
 *   GET /v1/games/limbo     — ?multiplier=1.01-100
 *   GET /v1/games/crash     — ?multiplier=1.01-100
 *
 * Start: npx ts-node server/index.ts
 */

import express from 'express';
import cors from 'cors';
import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { AgentCasino } from '../sdk/src';
import { x402PaymentRequired } from './x402-middleware';

// Use require for wallet util (CommonJS compat)
const { loadWallet } = require('../scripts/utils/wallet');

const PORT = parseInt(process.env.PORT || '3402');
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const NETWORK = (process.env.NETWORK || 'devnet') as 'devnet' | 'mainnet-beta';
const BET_SOL = parseFloat(process.env.BET_SOL || '0.001');
const PRICE_USDC = parseFloat(process.env.PRICE_USDC || '0.01');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize casino
const connection = new Connection(RPC_URL, 'confirmed');
const { keypair } = loadWallet();
const casino = new AgentCasino(connection, keypair);
const walletAddress = keypair.publicKey.toString();

console.log(`Wallet: ${walletAddress}`);
console.log(`Network: ${NETWORK}`);
console.log(`Bet: ${BET_SOL} SOL per game`);
console.log(`Price: ${PRICE_USDC} USDC per game`);

// === Free Endpoints ===

app.get('/v1/health', (_req, res) => {
  res.json({
    status: 'ok',
    wallet: walletAddress,
    network: NETWORK,
    betSol: BET_SOL,
    priceUSDC: PRICE_USDC,
    x402: true,
    games: ['coinflip', 'diceroll', 'limbo', 'crash'],
  });
});

app.get('/v1/stats', async (_req, res) => {
  try {
    const stats = await casino.getHouseStats();
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// === x402 Payment Options (shared config) ===

const paymentOpts = (game: string) => ({
  recipientWallet: walletAddress,
  priceUSDC: PRICE_USDC,
  connection,
  description: `Play ${game} at Agent Casino (${BET_SOL} SOL bet, ~1.98x payout)`,
  network: NETWORK,
});

// === Paid Endpoints ===

app.get('/v1/games/coinflip',
  x402PaymentRequired(paymentOpts('coin flip')),
  async (req, res) => {
    const choice = (req.query.choice as string) === 'tails' ? 'tails' : 'heads';
    try {
      const result = await casino.coinFlip(BET_SOL, choice);
      res.json({
        game: 'coinflip',
        choice,
        won: result.won,
        payout: result.payout,
        txSignature: result.txSignature,
        serverSeed: result.serverSeed,
        clientSeed: result.clientSeed,
        verificationHash: result.verificationHash,
        paymentTx: (req as any).x402Payment?.signature,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

app.get('/v1/games/diceroll',
  x402PaymentRequired(paymentOpts('dice roll')),
  async (req, res) => {
    const target = Math.min(5, Math.max(1, parseInt(req.query.target as string) || 3));
    try {
      const result = await casino.diceRoll(BET_SOL, target as any);
      res.json({
        game: 'diceroll',
        target,
        won: result.won,
        payout: result.payout,
        txSignature: result.txSignature,
        serverSeed: result.serverSeed,
        clientSeed: result.clientSeed,
        paymentTx: (req as any).x402Payment?.signature,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

app.get('/v1/games/limbo',
  x402PaymentRequired(paymentOpts('limbo')),
  async (req, res) => {
    const multiplier = Math.min(100, Math.max(1.01, parseFloat(req.query.multiplier as string) || 2.0));
    try {
      const result = await casino.limbo(BET_SOL, multiplier);
      res.json({
        game: 'limbo',
        targetMultiplier: multiplier,
        won: result.won,
        payout: result.payout,
        txSignature: result.txSignature,
        serverSeed: result.serverSeed,
        clientSeed: result.clientSeed,
        paymentTx: (req as any).x402Payment?.signature,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

app.get('/v1/games/crash',
  x402PaymentRequired(paymentOpts('crash')),
  async (req, res) => {
    const multiplier = Math.min(100, Math.max(1.01, parseFloat(req.query.multiplier as string) || 1.5));
    try {
      const result = await casino.crash(BET_SOL, multiplier);
      res.json({
        game: 'crash',
        cashoutMultiplier: multiplier,
        won: result.won,
        payout: result.payout,
        txSignature: result.txSignature,
        serverSeed: result.serverSeed,
        clientSeed: result.clientSeed,
        paymentTx: (req as any).x402Payment?.signature,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

// === Start Server ===

app.listen(PORT, () => {
  console.log(`\nAgent Casino x402 API running on http://localhost:${PORT}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET /v1/health                    (free)`);
  console.log(`  GET /v1/stats                     (free)`);
  console.log(`  GET /v1/games/coinflip?choice=     (x402: ${PRICE_USDC} USDC)`);
  console.log(`  GET /v1/games/diceroll?target=      (x402: ${PRICE_USDC} USDC)`);
  console.log(`  GET /v1/games/limbo?multiplier=     (x402: ${PRICE_USDC} USDC)`);
  console.log(`  GET /v1/games/crash?multiplier=     (x402: ${PRICE_USDC} USDC)`);
  console.log(`\nTest: curl http://localhost:${PORT}/v1/health`);
});
