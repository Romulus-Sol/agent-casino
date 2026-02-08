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
import rateLimit from 'express-rate-limit';
import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { AgentCasino } from '../sdk/src';
import { x402PaymentRequired } from './x402-middleware';
import { requireMoltLaunchVerification, getMoltLaunchInfo, getVerificationStatus } from './moltlaunch-gate';

// Use require for wallet util (CommonJS compat)
const { loadWallet } = require('../scripts/utils/wallet');

const PORT = parseInt(process.env.PORT || '3402');
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const NETWORK = (process.env.NETWORK || 'devnet') as 'devnet' | 'mainnet-beta';
const BET_SOL = parseFloat(process.env.BET_SOL || '0.001');
const PRICE_USDC = parseFloat(process.env.PRICE_USDC || '0.01');

const app = express();

// CORS: intentionally open — this is a public API for any agent to use
app.use(cors());
app.use(express.json());

// H2: Rate limiting
const freeLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, try again later' },
});

const gameLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, try again later' },
});

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

app.get('/v1/health', freeLimiter, (_req, res) => {
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

app.get('/v1/stats', freeLimiter, async (_req, res) => {
  try {
    const stats = await casino.getHouseStats();
    res.json(stats);
  } catch (err: any) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
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

// === Paid Endpoints (GET follows x402 protocol convention where payment header gates the request) ===

app.get('/v1/games/coinflip',
  gameLimiter,
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
      console.error('Coinflip error:', err);
      res.status(500).json({ error: 'Game execution failed' });
    }
  }
);

app.get('/v1/games/diceroll',
  gameLimiter,
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
      console.error('Diceroll error:', err);
      res.status(500).json({ error: 'Game execution failed' });
    }
  }
);

app.get('/v1/games/limbo',
  gameLimiter,
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
      console.error('Limbo error:', err);
      res.status(500).json({ error: 'Game execution failed' });
    }
  }
);

app.get('/v1/games/crash',
  gameLimiter,
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
      console.error('Crash error:', err);
      res.status(500).json({ error: 'Game execution failed' });
    }
  }
);

// ============================================
// HIGH-ROLLER TABLES (MoltLaunch Verified Only)
// ============================================

const HIGH_ROLLER_BET = parseFloat(process.env.HIGH_ROLLER_BET || '0.1');
const HIGH_ROLLER_PRICE = parseFloat(process.env.HIGH_ROLLER_PRICE || '0.10');

const highRollerPaymentOpts = (game: string) => ({
  recipientWallet: walletAddress,
  priceUSDC: HIGH_ROLLER_PRICE,
  connection,
  description: `High-Roller ${game} at Agent Casino (${HIGH_ROLLER_BET} SOL bet, 1.99x payout)`,
  network: NETWORK,
});

// MoltLaunch verification info
app.get('/v1/highroller/info', freeLimiter, getMoltLaunchInfo);

// Check agent verification status
app.get('/v1/highroller/status/:agentId', freeLimiter, getVerificationStatus);
app.get('/v1/highroller/status', freeLimiter, getVerificationStatus);

// High-Roller Coin Flip (MoltLaunch verified agents only)
app.get('/v1/highroller/coinflip',
  gameLimiter,
  requireMoltLaunchVerification(70),
  x402PaymentRequired(highRollerPaymentOpts('coin flip')),
  async (req, res) => {
    const moltlaunch = (req as any).moltlaunch;
    const choice = (req.query.choice as string) === 'tails' ? 'tails' : 'heads';
    const betAmount = Math.min(moltlaunch.limits.maxBet, HIGH_ROLLER_BET);
    
    try {
      const result = await casino.coinFlip(betAmount, choice);
      res.json({
        game: 'highroller-coinflip',
        choice,
        won: result.won,
        payout: result.payout,
        betAmount,
        txSignature: result.txSignature,
        serverSeed: result.serverSeed,
        clientSeed: result.clientSeed,
        verificationHash: result.verificationHash,
        paymentTx: (req as any).x402Payment?.signature,
        moltlaunch: {
          agentId: moltlaunch.agentId,
          score: moltlaunch.score,
          tier: moltlaunch.tier
        }
      });
    } catch (err: any) {
      console.error('High-roller coinflip error:', err);
      res.status(500).json({ error: 'Game execution failed' });
    }
  }
);

// High-Roller Dice Roll (MoltLaunch verified agents only)
app.get('/v1/highroller/diceroll',
  gameLimiter,
  requireMoltLaunchVerification(70),
  x402PaymentRequired(highRollerPaymentOpts('dice roll')),
  async (req, res) => {
    const moltlaunch = (req as any).moltlaunch;
    const target = Math.min(5, Math.max(1, parseInt(req.query.target as string) || 3));
    const betAmount = Math.min(moltlaunch.limits.maxBet, HIGH_ROLLER_BET);
    
    try {
      const result = await casino.diceRoll(betAmount, target as any);
      res.json({
        game: 'highroller-diceroll',
        target,
        won: result.won,
        payout: result.payout,
        betAmount,
        txSignature: result.txSignature,
        serverSeed: result.serverSeed,
        clientSeed: result.clientSeed,
        paymentTx: (req as any).x402Payment?.signature,
        moltlaunch: {
          agentId: moltlaunch.agentId,
          score: moltlaunch.score,
          tier: moltlaunch.tier
        }
      });
    } catch (err: any) {
      console.error('High-roller diceroll error:', err);
      res.status(500).json({ error: 'Game execution failed' });
    }
  }
);

// High-Roller Limbo (MoltLaunch verified agents only)
app.get('/v1/highroller/limbo',
  gameLimiter,
  requireMoltLaunchVerification(70),
  x402PaymentRequired(highRollerPaymentOpts('limbo')),
  async (req, res) => {
    const moltlaunch = (req as any).moltlaunch;
    const multiplier = Math.min(100, Math.max(1.01, parseFloat(req.query.multiplier as string) || 2.0));
    const betAmount = Math.min(moltlaunch.limits.maxBet, HIGH_ROLLER_BET);
    
    try {
      const result = await casino.limbo(betAmount, multiplier);
      res.json({
        game: 'highroller-limbo',
        targetMultiplier: multiplier,
        won: result.won,
        payout: result.payout,
        betAmount,
        txSignature: result.txSignature,
        serverSeed: result.serverSeed,
        clientSeed: result.clientSeed,
        paymentTx: (req as any).x402Payment?.signature,
        moltlaunch: {
          agentId: moltlaunch.agentId,
          score: moltlaunch.score,
          tier: moltlaunch.tier
        }
      });
    } catch (err: any) {
      console.error('High-roller limbo error:', err);
      res.status(500).json({ error: 'Game execution failed' });
    }
  }
);

// === Start Server ===

app.listen(PORT, () => {
  console.log(`\nAgent Casino x402 API running on http://localhost:${PORT}`);
  console.log(`\nStandard Tables:`);
  console.log(`  GET /v1/health                    (free, 60/min)`);
  console.log(`  GET /v1/stats                     (free, 60/min)`);
  console.log(`  GET /v1/games/coinflip?choice=    (x402: ${PRICE_USDC} USDC, 10/min)`);
  console.log(`  GET /v1/games/diceroll?target=    (x402: ${PRICE_USDC} USDC, 10/min)`);
  console.log(`  GET /v1/games/limbo?multiplier=   (x402: ${PRICE_USDC} USDC, 10/min)`);
  console.log(`  GET /v1/games/crash?multiplier=   (x402: ${PRICE_USDC} USDC, 10/min)`);
  console.log(`\nHigh-Roller Tables (MoltLaunch Verified):`);
  console.log(`  GET /v1/highroller/info           (free, verification info)`);
  console.log(`  GET /v1/highroller/status/:agentId (free, check eligibility)`);
  console.log(`  GET /v1/highroller/coinflip       (x402: ${HIGH_ROLLER_PRICE} USDC, score 70+)`);
  console.log(`  GET /v1/highroller/diceroll       (x402: ${HIGH_ROLLER_PRICE} USDC, score 70+)`);
  console.log(`  GET /v1/highroller/limbo          (x402: ${HIGH_ROLLER_PRICE} USDC, score 70+)`);
  console.log(`\nTest: curl http://localhost:${PORT}/v1/health`);
  console.log(`Verify: curl http://localhost:${PORT}/v1/highroller/info`);
});
