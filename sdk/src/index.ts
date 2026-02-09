/**
 * Agent Casino SDK
 * 
 * A dead-simple SDK for AI agents to interact with the Agent Casino Protocol.
 * Designed for programmatic use with minimal configuration.
 * 
 * @example
 * ```typescript
 * import { AgentCasino } from '@agent-casino/sdk';
 * 
 * const casino = new AgentCasino(connection, wallet);
 * 
 * // Flip a coin
 * const result = await casino.coinFlip(0.1, 'heads');
 * console.log(result.won ? `Won ${result.payout} SOL!` : 'Lost');
 * 
 * // Check your stats
 * const stats = await casino.getMyStats();
 * console.log(`Win rate: ${stats.winRate}%`);
 * ```
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { Program, AnchorProvider, BN, Wallet } from '@coral-xyz/anchor';
import { randomBytes, createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { jupiterSwapToSol, JupiterSwapResult } from './jupiter';
import bs58 from 'bs58';

// Program ID - update after deployment
export const PROGRAM_ID = new PublicKey('5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV');

// === Types ===

export type CoinChoice = 'heads' | 'tails';
export type DiceTarget = 1 | 2 | 3 | 4 | 5;
export type RiskProvider = 'wargames' | 'none';

export interface CasinoConfig {
  riskProvider?: RiskProvider;
  maxRiskMultiplier?: number; // Cap for risk-adjusted bets (default: 2.0)
  minRiskMultiplier?: number; // Floor for risk-adjusted bets (default: 0.3)
}

export interface DecomposedRisk {
  volatility: { current: number; avg30d: number; percentile: number; status: string };
  liquidity: { spreadBps: number; slippage100k: number; status: string };
  flashCrashProb: number;
  correlationStatus: string;
  fundingRates: { SOL: number; BTC: number; ETH: number };
}

export interface BettingContext {
  betMultiplier: number;
  riskScore: number;
  bias: string;
  recommendation: string;
  signals: string[];
  warnings: string[];
  sentiment: { fearGreedValue: number; classification: string };
  memecoinMania: { score: number; trend: string };
  solanaHealthy: boolean;
  timestamp: number;
  decomposed?: DecomposedRisk;
  gameMultipliers?: { coinFlip: number; diceRoll: number; limbo: number; crash: number };
}

export interface GameResult {
  txSignature: string;
  won: boolean;
  payout: number; // in SOL
  result: number;
  choice: number;
  serverSeed: string;
  clientSeed: string;
  verificationHash: string;
  slot: number;
}

export interface HouseStats {
  pool: number; // in SOL
  houseEdgeBps: number;
  minBet: number; // in SOL
  maxBet: number; // in SOL
  totalGames: number;
  totalVolume: number; // in SOL
  totalPayout: number; // in SOL
  houseProfit: number; // in SOL
}

export interface AgentStats {
  agent: string;
  totalGames: number;
  totalWagered: number; // in SOL
  totalWon: number; // in SOL
  wins: number;
  losses: number;
  winRate: number; // percentage
  profit: number; // in SOL
  roi: number; // percentage
}

export interface LeaderboardEntry {
  rank: number;
  agent: string;
  totalGames: number;
  profit: number;
  roi: number;
  winRate: number;
}

export interface GameRecord {
  player: string;
  gameType: 'CoinFlip' | 'DiceRoll' | 'Limbo' | 'Crash';
  amount: number;
  choice: number;
  result: number;
  payout: number;
  timestamp: number;
  slot: number;
}

// SPL Token types

export interface TokenVaultStats {
  authority: string;
  mint: string;
  vaultAta: string;
  pool: number; // in token units
  houseEdgeBps: number;
  minBet: number; // in token units
  maxBetPercent: number;
  totalGames: number;
  totalVolume: number;
  totalPayout: number;
}

export interface TokenGameResult {
  txSignature: string;
  won: boolean;
  payout: number; // in token units
  result: number;
  choice: number;
  mint: string;
  serverSeed: string;
  clientSeed: string;
  slot: number;
}

export interface SwapAndPlayResult extends GameResult {
  swap: JupiterSwapResult;
}

// Memory Slots types

export type MemoryCategory = 'Strategy' | 'Technical' | 'Alpha' | 'Random';
export type MemoryRarity = 'Common' | 'Rare' | 'Legendary';

export interface MemoryPoolStats {
  address: string;
  authority: string;
  pullPrice: number;       // in SOL
  houseEdgeBps: number;
  stakeAmount: number;     // in SOL
  totalMemories: number;
  totalPulls: number;
  poolBalance: number;     // in SOL
}

export interface MemoryData {
  address: string;
  pool: string;
  depositor: string;
  index: number;
  content: string;
  category: MemoryCategory;
  rarity: MemoryRarity;
  stake: number;           // in SOL
  timesPulled: number;
  averageRating: number;   // 0-5
  ratingCount: number;
  active: boolean;
  createdAt: number;
}

export interface MemoryPullResult {
  txSignature: string;
  memory: MemoryData;
  pullPrice: number;       // in SOL
  depositorShare: number;  // in SOL
  houseTake: number;       // in SOL
}

export interface MemoryPullRecord {
  puller: string;
  memory: string;
  rating: number | null;
  timestamp: number;
}

// === Main SDK Class ===

export class AgentCasino {
  private connection: Connection;
  private wallet: Wallet;
  private provider: AnchorProvider;
  private housePda: PublicKey;
  private memoryPoolPda: PublicKey;
  private config: CasinoConfig;
  private program: Program | null = null;
  private cachedBettingContext: BettingContext | null = null;
  private contextCacheTime: number = 0;
  private readonly CONTEXT_CACHE_TTL = 60000; // 1 minute cache

  constructor(
    connection: Connection,
    wallet: Wallet | Keypair,
    programIdOrConfig?: PublicKey | CasinoConfig,
    config?: CasinoConfig
  ) {
    // Handle flexible constructor signatures
    let programId = PROGRAM_ID;
    if (programIdOrConfig instanceof PublicKey) {
      programId = programIdOrConfig;
      this.config = config || {};
    } else if (programIdOrConfig) {
      this.config = programIdOrConfig;
    } else {
      this.config = {};
    }
    this.connection = connection;
    
    // Handle both Wallet and Keypair
    if ('publicKey' in wallet && 'signTransaction' in wallet) {
      this.wallet = wallet as Wallet;
    } else {
      this.wallet = new KeypairWallet(wallet as Keypair);
    }

    this.provider = new AnchorProvider(connection, this.wallet, {
      commitment: 'confirmed',
    });

    // Derive PDAs
    [this.housePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('house')],
      programId
    );
    [this.memoryPoolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('memory_pool')],
      programId
    );
  }

  /**
   * Lazily load the Anchor Program instance from the IDL.
   */
  private async loadProgram(): Promise<void> {
    if (this.program) return;

    // Try common IDL locations relative to the project root
    const candidates = [
      resolve(process.cwd(), 'target/idl/agent_casino.json'),
      resolve(dirname(__dirname), '..', 'target/idl/agent_casino.json'),
      resolve(dirname(__dirname), 'target/idl/agent_casino.json'),
    ];

    let idl: any = null;
    for (const candidate of candidates) {
      try {
        idl = JSON.parse(readFileSync(candidate, 'utf-8'));
        break;
      } catch {
        // try next
      }
    }

    if (!idl) {
      throw new Error(
        'Could not find agent_casino IDL. Ensure target/idl/agent_casino.json exists (run `anchor build`).'
      );
    }

    this.program = new Program(idl, this.provider);
  }

  // === Init Methods (must call before first game/liquidity) ===

  /**
   * Initialize agent stats account. Must be called once before playing any game.
   * Idempotent — returns early if account already exists.
   */
  async initAgentStats(): Promise<string | null> {
    const [agentStatsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), this.wallet.publicKey.toBuffer()],
      PROGRAM_ID
    );

    // Check if already initialized
    const existing = await this.connection.getAccountInfo(agentStatsPda);
    if (existing) return null;

    const discriminator = Buffer.from([0x5f, 0x3a, 0xd2, 0x22, 0xd5, 0x06, 0x1f, 0xb8]);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: agentStatsPda, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: discriminator,
    });

    const tx = new Transaction().add(ix);
    return await this.provider.sendAndConfirm(tx);
  }

  /**
   * Ensure agent stats exist before playing. Auto-initializes if needed.
   */
  async ensureAgentStats(): Promise<void> {
    await this.initAgentStats();
  }

  /**
   * Initialize LP position account. Must be called once before adding liquidity.
   */
  async initLpPosition(): Promise<string | null> {
    const [lpPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('lp'), this.housePda.toBuffer(), this.wallet.publicKey.toBuffer()],
      PROGRAM_ID
    );

    const existing = await this.connection.getAccountInfo(lpPda);
    if (existing) return null;

    const discriminator = Buffer.from([0xc5, 0x57, 0x25, 0x16, 0xe3, 0x0a, 0x51, 0xdd]);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: this.housePda, isSigner: false, isWritable: false },
        { pubkey: lpPda, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: discriminator,
    });

    const tx = new Transaction().add(ix);
    return await this.provider.sendAndConfirm(tx);
  }

  /**
   * Initialize token LP position account. Must be called once before adding token liquidity.
   */
  async initTokenLpPosition(mintAddress: PublicKey): Promise<string | null> {
    const [tokenVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('token_vault'), mintAddress.toBuffer()],
      PROGRAM_ID
    );
    const [lpPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('token_lp'), tokenVaultPda.toBuffer(), this.wallet.publicKey.toBuffer()],
      PROGRAM_ID
    );

    const existing = await this.connection.getAccountInfo(lpPda);
    if (existing) return null;

    const discriminator = Buffer.from([0x98, 0x01, 0x6d, 0x13, 0x76, 0xb2, 0x31, 0x5a]);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: tokenVaultPda, isSigner: false, isWritable: false },
        { pubkey: mintAddress, isSigner: false, isWritable: false },
        { pubkey: lpPda, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: discriminator,
    });

    const tx = new Transaction().add(ix);
    return await this.provider.sendAndConfirm(tx);
  }

  // === Close Methods (rent recovery) ===

  /**
   * Close a game record to recover rent. Authority only.
   */
  async closeGameRecord(gameIndex: number, recipient?: PublicKey): Promise<string> {
    const [gameRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('game'), this.housePda.toBuffer(), new BN(gameIndex).toArrayLike(Buffer, 'le', 8)],
      PROGRAM_ID
    );

    const discriminator = Buffer.from([0x0b, 0xb5, 0x2e, 0x1a, 0xfe, 0x03, 0x40, 0x7a]);
    const data = Buffer.alloc(8 + 8);
    discriminator.copy(data);
    new BN(gameIndex).toArrayLike(Buffer, 'le', 8).copy(data, 8);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: this.housePda, isSigner: false, isWritable: false },
        { pubkey: gameRecordPda, isSigner: false, isWritable: true },
        { pubkey: recipient || this.wallet.publicKey, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    return await this.provider.sendAndConfirm(tx);
  }

  /**
   * Close a settled VRF request to recover rent. Authority only.
   */
  async closeVrfRequest(vrfRequestAddress: PublicKey, recipient?: PublicKey): Promise<string> {
    const discriminator = Buffer.from([0xe8, 0x5d, 0x65, 0x7c, 0x71, 0xc3, 0x6c, 0xb6]);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: this.housePda, isSigner: false, isWritable: false },
        { pubkey: vrfRequestAddress, isSigner: false, isWritable: true },
        { pubkey: recipient || this.wallet.publicKey, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
      ],
      data: discriminator,
    });

    const tx = new Transaction().add(ix);
    return await this.provider.sendAndConfirm(tx);
  }

  // === Game Methods (VRF-backed) ===

  /**
   * Retry wrapper for VRF requests — handles PDA collision from game index race
   */
  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const msg = err?.message || err?.toString() || '';
        if (attempt < maxRetries - 1 && (msg.includes('already in use') || msg.includes('0x0') || msg.includes('custom program error'))) {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw new Error('Max retries exceeded');
  }

  /**
   * Wait for a VRF request to be settled (poll until status changes from Pending)
   */
  private async waitForVrfSettle(vrfRequestPda: PublicKey, timeoutMs = 30000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const vrfRequest = await this.program.account.vrfRequest.fetch(vrfRequestPda);
        // status 1 = Settled, status 2 = Expired
        if (vrfRequest.status && (vrfRequest as any).status.settled !== undefined) {
          return vrfRequest;
        }
        if (vrfRequest.status && (vrfRequest as any).status.expired !== undefined) {
          throw new Error('VRF request expired');
        }
      } catch (err: any) {
        if (err.message?.includes('expired')) throw err;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('VRF settle timeout');
  }

  /**
   * Flip a coin - 50/50 odds (VRF-backed)
   * @param amountSol Amount to bet in SOL
   * @param choice 'heads' or 'tails'
   * @param randomnessAccount Switchboard randomness account address
   * @returns Game result
   */
  async coinFlip(amountSol: number, choice: CoinChoice, randomnessAccount?: string): Promise<GameResult> {
    await this.ensureAgentStats();
    if (!randomnessAccount) {
      throw new Error('randomnessAccount is required — create one via Switchboard SDK');
    }
    const result = await this.withRetry(async () => {
      const { vrfRequestAddress } = await this.vrfCoinFlipRequest(amountSol, choice, randomnessAccount);
      return { vrfRequestAddress };
    });
    // Settle
    const settleResult = await this.vrfCoinFlipSettle(result.vrfRequestAddress, randomnessAccount);
    return {
      signature: settleResult.tx,
      won: settleResult.won,
      payout: settleResult.payout,
      gameType: 'CoinFlip',
      amount: amountSol,
      result: settleResult.won ? (choice === 'heads' ? 0 : 1) : (choice === 'heads' ? 1 : 0),
      choice: choice === 'heads' ? 0 : 1,
    };
  }

  /**
   * Roll dice - choose a target, win if roll <= target (VRF-backed)
   * @param amountSol Amount to bet in SOL
   * @param target Target number (1-5)
   * @param randomnessAccount Switchboard randomness account address
   * @returns Game result
   */
  async diceRoll(amountSol: number, target: DiceTarget, randomnessAccount?: string): Promise<GameResult> {
    await this.ensureAgentStats();
    if (!randomnessAccount) {
      throw new Error('randomnessAccount is required — create one via Switchboard SDK');
    }
    const result = await this.withRetry(async () => {
      const { vrfRequestAddress } = await this.vrfDiceRollRequest(amountSol, target, randomnessAccount);
      return { vrfRequestAddress };
    });
    const settleResult = await this.vrfDiceRollSettle(result.vrfRequestAddress, randomnessAccount);
    return {
      signature: settleResult.tx,
      won: settleResult.won,
      payout: settleResult.payout,
      gameType: 'DiceRoll',
      amount: amountSol,
      result: settleResult.result,
      choice: target,
    };
  }

  /**
   * Limbo - set a target multiplier, win if result >= target (VRF-backed)
   * @param amountSol Amount to bet in SOL
   * @param targetMultiplier Target multiplier (1.01x - 100x)
   * @param randomnessAccount Switchboard randomness account address
   * @returns Game result
   */
  async limbo(amountSol: number, targetMultiplier: number, randomnessAccount?: string): Promise<GameResult> {
    await this.ensureAgentStats();
    if (targetMultiplier < 1.01 || targetMultiplier > 100) {
      throw new Error('Target multiplier must be between 1.01 and 100');
    }
    if (!randomnessAccount) {
      throw new Error('randomnessAccount is required — create one via Switchboard SDK');
    }
    const result = await this.withRetry(async () => {
      const { vrfRequestAddress } = await this.vrfLimboRequest(amountSol, targetMultiplier, randomnessAccount);
      return { vrfRequestAddress };
    });
    const settleResult = await this.vrfLimboSettle(result.vrfRequestAddress, randomnessAccount);
    return {
      signature: settleResult.tx,
      won: settleResult.won,
      payout: settleResult.payout,
      gameType: 'Limbo',
      amount: amountSol,
      result: 0,
      choice: Math.floor(targetMultiplier * 100),
    };
  }

  /**
   * Play crash - set your cashout multiplier (VRF-backed)
   * @param amountSol Amount to bet in SOL
   * @param cashoutMultiplier Target cashout multiplier (1.01 to 100)
   * @param randomnessAccount Switchboard randomness account address
   * @returns Game result
   */
  async crash(amountSol: number, cashoutMultiplier: number, randomnessAccount?: string): Promise<GameResult> {
    await this.ensureAgentStats();
    if (cashoutMultiplier < 1.01 || cashoutMultiplier > 100) {
      throw new Error('Cashout multiplier must be between 1.01 and 100');
    }
    if (!randomnessAccount) {
      throw new Error('randomnessAccount is required — create one via Switchboard SDK');
    }
    const result = await this.withRetry(async () => {
      const { vrfRequestAddress } = await this.vrfCrashRequest(amountSol, cashoutMultiplier, randomnessAccount);
      return { vrfRequestAddress };
    });
    const settleResult = await this.vrfCrashSettle(result.vrfRequestAddress, randomnessAccount);
    return {
      signature: settleResult.tx,
      won: settleResult.won,
      payout: settleResult.payout,
      gameType: 'Crash',
      amount: amountSol,
      result: 0,
      choice: Math.floor(cashoutMultiplier * 100),
    };
  }

  // === Stats & Analytics ===

  /**
   * Get current house stats
   */
  async getHouseStats(): Promise<HouseStats> {
    const house = await this.getHouseAccount();
    const maxBet = (house.pool * house.maxBetPercent) / 100;

    return {
      pool: house.pool / LAMPORTS_PER_SOL,
      houseEdgeBps: house.houseEdgeBps,
      minBet: house.minBet / LAMPORTS_PER_SOL,
      maxBet: maxBet / LAMPORTS_PER_SOL,
      totalGames: this.safeToNumber(house.totalGames),
      totalVolume: this.safeToNumber(house.totalVolume) / LAMPORTS_PER_SOL,
      totalPayout: this.safeToNumber(house.totalPayout) / LAMPORTS_PER_SOL,
      houseProfit: (this.safeToNumber(house.totalVolume) - this.safeToNumber(house.totalPayout)) / LAMPORTS_PER_SOL,
    };
  }

  /**
   * Get your agent's stats
   */
  async getMyStats(): Promise<AgentStats> {
    return this.getAgentStats(this.wallet.publicKey);
  }

  /**
   * Get any agent's stats
   */
  async getAgentStats(agent: PublicKey): Promise<AgentStats> {
    const [agentStatsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), agent.toBuffer()],
      PROGRAM_ID
    );

    try {
      const stats = await this.fetchAgentStats(agentStatsPda);
      const totalWon = this.safeToNumber(stats.totalWon);
      const totalWagered = this.safeToNumber(stats.totalWagered);
      const totalGames = this.safeToNumber(stats.totalGames);
      const wins = this.safeToNumber(stats.wins);
      const losses = this.safeToNumber(stats.losses);
      const profit = (totalWon - totalWagered) / LAMPORTS_PER_SOL;
      const wageredSol = totalWagered / LAMPORTS_PER_SOL;

      return {
        agent: agent.toString(),
        totalGames,
        totalWagered: wageredSol,
        totalWon: totalWon / LAMPORTS_PER_SOL,
        wins,
        losses,
        winRate: totalGames > 0 ? (wins / totalGames) * 100 : 0,
        profit,
        roi: wageredSol > 0 ? (profit / wageredSol) * 100 : 0,
      };
    } catch (e) {
      // Agent has no games yet
      return {
        agent: agent.toString(),
        totalGames: 0,
        totalWagered: 0,
        totalWon: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        profit: 0,
        roi: 0,
      };
    }
  }

  /**
   * Get game history for analysis
   */
  async getGameHistory(limit: number = 100): Promise<GameRecord[]> {
    // Fetch recent game records
    const house = await this.getHouseAccount();
    const totalGames = this.safeToNumber(house.totalGames);
    const startIndex = Math.max(0, totalGames - limit);
    
    const records: GameRecord[] = [];
    
    for (let i = startIndex; i < totalGames; i++) {
      try {
        const [gameRecordPda] = PublicKey.findProgramAddressSync(
          [
            Buffer.from('game'),
            this.housePda.toBuffer(),
            new BN(i).toArrayLike(Buffer, 'le', 8),
          ],
          PROGRAM_ID
        );
        
        const record = await this.fetchGameRecord(gameRecordPda);
        records.push({
          player: record.player.toString(),
          gameType: this.parseGameType(record.gameType),
          amount: this.safeToNumber(record.amount) / LAMPORTS_PER_SOL,
          choice: record.choice,
          result: record.result,
          payout: this.safeToNumber(record.payout) / LAMPORTS_PER_SOL,
          timestamp: record.timestamp.toNumber(),
          slot: record.slot.toNumber(),
        });
      } catch (e) {
        // Skip failed fetches
      }
    }

    return records;
  }

  // === Liquidity Provider Methods ===

  /**
   * Add liquidity to become the house
   */
  async addLiquidity(amountSol: number): Promise<string> {
    await this.initLpPosition();
    const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

    const [lpPositionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('lp'),
        this.housePda.toBuffer(),
        this.wallet.publicKey.toBuffer(),
      ],
      PROGRAM_ID
    );

    // Build transaction manually
    const ix = {
      programId: PROGRAM_ID,
      keys: [
        { pubkey: this.housePda, isSigner: false, isWritable: true },
        { pubkey: lpPositionPda, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([
        // add_liquidity discriminator + amount
        ...Buffer.from([0xb5, 0x9d, 0x59, 0x43, 0x8f, 0xb6, 0x34, 0x48]),
        ...new BN(amountLamports).toArrayLike(Buffer, 'le', 8),
      ]),
    };

    const tx = new Transaction().add(ix);
    return await this.provider.sendAndConfirm(tx);
  }

  // === Risk Management (WARGAMES Integration) ===

  /**
   * Get current betting context from WARGAMES API
   * Returns risk-adjusted bet multiplier based on macro conditions
   */
  async getBettingContext(): Promise<BettingContext> {
    // Return cached context if fresh
    if (this.cachedBettingContext && Date.now() - this.contextCacheTime < this.CONTEXT_CACHE_TTL) {
      return this.cachedBettingContext;
    }

    if (this.config.riskProvider !== 'wargames') {
      return {
        betMultiplier: 1.0,
        riskScore: 50,
        bias: 'neutral',
        recommendation: 'Risk provider not configured',
        signals: [],
        warnings: [],
        sentiment: { fearGreedValue: 50, classification: 'unknown' },
        memecoinMania: { score: 50, trend: 'stable' },
        solanaHealthy: true,
        timestamp: Date.now(),
      };
    }

    try {
      // Fetch betting context, Solana health, and decomposed risk in parallel
      const [ctxRes, solRes, decompRes] = await Promise.all([
        fetch('https://wargames-api.vercel.app/live/betting-context'),
        fetch('https://wargames-api.vercel.app/live/solana'),
        fetch('https://wargames-api.fly.dev/oracle/risk/decomposed'),
      ]);
      const ctx: any = await ctxRes.json();
      const sol: any = await solRes.json();
      const decomp: any = await decompRes.json().catch(() => null);

      // Apply multiplier caps from config
      let multiplier = ctx.bet_multiplier || 1.0;
      const maxMult = this.config.maxRiskMultiplier || 2.0;
      const minMult = this.config.minRiskMultiplier || 0.3;
      multiplier = Math.max(minMult, Math.min(maxMult, multiplier));

      // Gate on Solana network health
      const solanaHealthy = sol.recommendations?.execute_transactions !== false;
      if (!solanaHealthy) {
        multiplier = minMult; // Minimum bet if network is unhealthy
      }

      // Parse decomposed risk factors
      const volPercentile = decomp?.components?.volatility_regime?.percentile ?? 50;
      const volStatus = decomp?.components?.volatility_regime?.status ?? 'normal';
      const liqStatus = decomp?.components?.liquidity_stress?.status ?? 'normal';
      const spreadBps = decomp?.components?.liquidity_stress?.average_spread_bps ?? 5;
      const slippage = decomp?.components?.liquidity_stress?.average_slippage_100k ?? 0.1;
      const flashProb = decomp?.components?.flash_crash_probability?.probability ?? 0.02;
      const corrStatus = decomp?.components?.correlations?.status ?? 'normal';

      const decomposed: DecomposedRisk = {
        volatility: {
          current: decomp?.components?.volatility_regime?.current_volatility ?? 0,
          avg30d: decomp?.components?.volatility_regime?.rolling_30d_avg ?? 0,
          percentile: volPercentile,
          status: volStatus,
        },
        liquidity: { spreadBps, slippage100k: slippage, status: liqStatus },
        flashCrashProb: flashProb,
        correlationStatus: corrStatus,
        fundingRates: {
          SOL: decomp?.components?.funding_rates?.SOL?.current ?? 0,
          BTC: decomp?.components?.funding_rates?.BTC?.current ?? 0,
          ETH: decomp?.components?.funding_rates?.ETH?.current ?? 0,
        },
      };

      // Compute game-specific multipliers using decomposed factors
      // Coin flip (50/50, lowest risk game): mainly sentiment-driven
      const coinFlipMult = multiplier;

      // Dice roll (variable odds): factor in volatility
      const volFactor = volPercentile > 75 ? 0.85 : volPercentile > 50 ? 0.95 : 1.0;
      const diceRollMult = Math.max(minMult, multiplier * volFactor);

      // Limbo (high multiplier targets): volatility + liquidity stress
      const liqFactor = liqStatus === 'stressed' ? 0.8 : liqStatus === 'warning' ? 0.9 : 1.0;
      const limboMult = Math.max(minMult, multiplier * volFactor * liqFactor);

      // Crash (exponential risk): most aggressive — vol + flash crash + liquidity
      const flashFactor = flashProb > 0.1 ? 0.7 : flashProb > 0.05 ? 0.85 : 1.0;
      const crashMult = Math.max(minMult, multiplier * volFactor * liqFactor * flashFactor);

      this.cachedBettingContext = {
        betMultiplier: multiplier,
        riskScore: ctx.risk_score || 50,
        bias: ctx.bias || 'neutral',
        recommendation: ctx.recommendation || 'No recommendation',
        signals: ctx.signals || [],
        warnings: ctx.warnings || [],
        sentiment: {
          fearGreedValue: ctx.sentiment?.fear_greed_value ?? 50,
          classification: ctx.sentiment?.classification || 'unknown',
        },
        memecoinMania: {
          score: ctx.narratives?.memecoin_mania?.score ?? 50,
          trend: ctx.narratives?.memecoin_mania?.trend || 'stable',
        },
        solanaHealthy,
        timestamp: Date.now(),
        decomposed,
        gameMultipliers: {
          coinFlip: coinFlipMult,
          diceRoll: diceRollMult,
          limbo: limboMult,
          crash: crashMult,
        },
      };
      this.contextCacheTime = Date.now();

      return this.cachedBettingContext;
    } catch (e) {
      // Fallback to neutral on API failure
      return {
        betMultiplier: 1.0,
        riskScore: 50,
        bias: 'neutral',
        recommendation: 'WARGAMES API unavailable - using neutral settings',
        signals: [],
        warnings: ['api_unavailable'],
        sentiment: { fearGreedValue: 50, classification: 'unknown' },
        memecoinMania: { score: 50, trend: 'stable' },
        solanaHealthy: true,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Get risk-adjusted bet amount
   * Scales your base bet based on macro conditions
   */
  async getRiskAdjustedBet(baseBetSol: number): Promise<{ adjustedBet: number; context: BettingContext }> {
    const context = await this.getBettingContext();
    return {
      adjustedBet: baseBetSol * context.betMultiplier,
      context,
    };
  }

  /**
   * Coin flip with automatic risk adjustment
   * Bet size scales based on macro conditions when riskProvider is configured
   */
  async smartCoinFlip(baseBetSol: number, choice: CoinChoice, randomnessAccount?: string): Promise<GameResult & { riskContext?: BettingContext }> {
    if (this.config.riskProvider === 'wargames') {
      const context = await this.getBettingContext();
      const mult = context.gameMultipliers?.coinFlip ?? context.betMultiplier;
      const adjustedBet = baseBetSol * mult;
      const result = await this.coinFlip(adjustedBet, choice, randomnessAccount);
      return { ...result, riskContext: context };
    }
    return this.coinFlip(baseBetSol, choice, randomnessAccount);
  }

  /**
   * Dice roll with automatic risk adjustment
   * Scales more aggressively in high-volatility environments
   */
  async smartDiceRoll(baseBetSol: number, target: DiceTarget, randomnessAccount?: string): Promise<GameResult & { riskContext?: BettingContext }> {
    if (this.config.riskProvider === 'wargames') {
      const context = await this.getBettingContext();
      const mult = context.gameMultipliers?.diceRoll ?? context.betMultiplier;
      const adjustedBet = baseBetSol * mult;
      const result = await this.diceRoll(adjustedBet, target, randomnessAccount);
      return { ...result, riskContext: context };
    }
    return this.diceRoll(baseBetSol, target, randomnessAccount);
  }

  /**
   * Limbo with automatic risk adjustment
   * Factors in volatility + liquidity stress for high-multiplier targets
   */
  async smartLimbo(baseBetSol: number, targetMultiplier: number, randomnessAccount?: string): Promise<GameResult & { riskContext?: BettingContext }> {
    if (this.config.riskProvider === 'wargames') {
      const context = await this.getBettingContext();
      const mult = context.gameMultipliers?.limbo ?? context.betMultiplier;
      const adjustedBet = baseBetSol * mult;
      const result = await this.limbo(adjustedBet, targetMultiplier, randomnessAccount);
      return { ...result, riskContext: context };
    }
    return this.limbo(baseBetSol, targetMultiplier, randomnessAccount);
  }

  /**
   * Crash with automatic risk adjustment
   * Most aggressive scaling — factors in volatility + flash crash probability + liquidity
   */
  async smartCrash(baseBetSol: number, targetMultiplier: number, randomnessAccount?: string): Promise<GameResult & { riskContext?: BettingContext }> {
    if (this.config.riskProvider === 'wargames') {
      const context = await this.getBettingContext();
      const mult = context.gameMultipliers?.crash ?? context.betMultiplier;
      const adjustedBet = baseBetSol * mult;
      const result = await this.crash(adjustedBet, targetMultiplier, randomnessAccount);
      return { ...result, riskContext: context };
    }
    return this.crash(baseBetSol, targetMultiplier, randomnessAccount);
  }

  // === Jupiter Auto-Swap Methods ===

  /**
   * Swap any SPL token to SOL via Jupiter, then play coin flip.
   * On devnet, uses mock swap (Jupiter only supports mainnet).
   * @param inputMint - SPL token mint address (e.g., USDC)
   * @param tokenAmount - Amount in token base units (e.g., 1000000 = 1 USDC)
   * @param choice - 'heads' or 'tails'
   */
  async swapAndCoinFlip(inputMint: string, tokenAmount: number, choice: CoinChoice, randomnessAccount?: string): Promise<SwapAndPlayResult> {
    const swap = await this.jupiterSwap(inputMint, tokenAmount);
    if (swap.mock) {
      console.warn(`[AgentCasino] Mock swap: no actual token swap performed. Using ${swap.solAmount} SOL from wallet.`);
    }
    try {
      const result = await this.coinFlip(swap.solAmount, choice, randomnessAccount);
      return { ...result, swap };
    } catch (err: any) {
      throw new Error(`Swap succeeded (${swap.signature}) but game failed: ${err.message}. SOL from swap is in your wallet.`);
    }
  }

  /**
   * Swap any SPL token to SOL via Jupiter, then play dice roll.
   */
  async swapAndDiceRoll(inputMint: string, tokenAmount: number, target: DiceTarget, randomnessAccount?: string): Promise<SwapAndPlayResult> {
    const swap = await this.jupiterSwap(inputMint, tokenAmount);
    if (swap.mock) {
      console.warn(`[AgentCasino] Mock swap: no actual token swap performed. Using ${swap.solAmount} SOL from wallet.`);
    }
    try {
      const result = await this.diceRoll(swap.solAmount, target, randomnessAccount);
      return { ...result, swap };
    } catch (err: any) {
      throw new Error(`Swap succeeded (${swap.signature}) but game failed: ${err.message}. SOL from swap is in your wallet.`);
    }
  }

  /**
   * Swap any SPL token to SOL via Jupiter, then play limbo.
   */
  async swapAndLimbo(inputMint: string, tokenAmount: number, targetMultiplier: number, randomnessAccount?: string): Promise<SwapAndPlayResult> {
    const swap = await this.jupiterSwap(inputMint, tokenAmount);
    if (swap.mock) {
      console.warn(`[AgentCasino] Mock swap: no actual token swap performed. Using ${swap.solAmount} SOL from wallet.`);
    }
    try {
      const result = await this.limbo(swap.solAmount, targetMultiplier, randomnessAccount);
      return { ...result, swap };
    } catch (err: any) {
      throw new Error(`Swap succeeded (${swap.signature}) but game failed: ${err.message}. SOL from swap is in your wallet.`);
    }
  }

  /**
   * Swap any SPL token to SOL via Jupiter, then play crash.
   */
  async swapAndCrash(inputMint: string, tokenAmount: number, cashoutMultiplier: number, randomnessAccount?: string): Promise<SwapAndPlayResult> {
    const swap = await this.jupiterSwap(inputMint, tokenAmount);
    if (swap.mock) {
      console.warn(`[AgentCasino] Mock swap: no actual token swap performed. Using ${swap.solAmount} SOL from wallet.`);
    }
    try {
      const result = await this.crash(swap.solAmount, cashoutMultiplier, randomnessAccount);
      return { ...result, swap };
    } catch (err: any) {
      throw new Error(`Swap succeeded (${swap.signature}) but game failed: ${err.message}. SOL from swap is in your wallet.`);
    }
  }

  private async jupiterSwap(inputMint: string, tokenAmount: number): Promise<JupiterSwapResult> {
    return jupiterSwapToSol(
      inputMint,
      tokenAmount,
      this.wallet.publicKey.toString(),
      async (tx: VersionedTransaction) => {
        return await this.wallet.signTransaction(tx) as VersionedTransaction;
      },
      this.connection,
    );
  }

  // === Verification Methods ===

  /**
   * Verify a game result is fair
   * Agents can use this to audit results
   */
  /**
   * Verify a game result is fair
   * @param serverSeed Server seed hex string
   * @param clientSeed Client seed hex string
   * @param playerPubkey Player's public key
   * @param expectedResult Expected result value
   * @param gameType Game type: 'coinFlip' | 'diceRoll' | 'limbo' | 'crash'
   */
  verifyResult(
    serverSeed: string,
    clientSeed: string,
    playerPubkey: string,
    expectedResult: number,
    gameType: 'coinFlip' | 'diceRoll' | 'limbo' | 'crash' = 'coinFlip'
  ): boolean {
    const combined = Buffer.concat([
      Buffer.from(serverSeed, 'hex'),
      Buffer.from(clientSeed, 'hex'),
      new PublicKey(playerPubkey).toBuffer(),
    ]);

    const hash = createHash('sha256').update(combined).digest();

    switch (gameType) {
      case 'coinFlip':
        return (hash[0] % 2) === expectedResult;
      case 'diceRoll': {
        const raw = hash.readUInt32LE(0);
        return ((raw % 6) + 1) === expectedResult;
      }
      case 'limbo':
      case 'crash':
        // For limbo/crash, result is a multiplier - verify raw matches
        // Full verification requires reimplementing calculate_limbo_result/calculate_crash_point
        const raw = hash.readUInt32LE(0);
        return raw === expectedResult;
      default:
        return (hash[0] % 2) === expectedResult;
    }
  }

  // === SPL Token Methods ===

  private static readonly TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

  /**
   * Derive token vault PDAs for a given mint
   */
  private deriveTokenVaultPdas(mint: PublicKey) {
    const [tokenVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('token_vault'), mint.toBuffer()],
      PROGRAM_ID
    );
    const [vaultAtaPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('token_vault_ata'), mint.toBuffer()],
      PROGRAM_ID
    );
    return { tokenVaultPda, vaultAtaPda };
  }

  /**
   * Initialize a token vault for SPL token betting
   * @param mint SPL token mint address
   * @param houseEdgeBps House edge in basis points (e.g., 100 = 1%)
   * @param minBet Minimum bet in token base units
   * @param maxBetPercent Max bet as percentage of pool (1-10)
   */
  async initializeTokenVault(
    mint: string | PublicKey,
    houseEdgeBps: number,
    minBet: number,
    maxBetPercent: number
  ): Promise<string> {
    const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
    const { tokenVaultPda, vaultAtaPda } = this.deriveTokenVaultPdas(mintPubkey);

    const discriminator = Buffer.from([0x40, 0xca, 0x71, 0xcd, 0x16, 0xd2, 0xb2, 0xe1]);
    const instructionData = Buffer.concat([
      discriminator,
      Buffer.from(new Uint16Array([houseEdgeBps]).buffer),
      new BN(minBet).toArrayLike(Buffer, 'le', 8),
      Buffer.from([maxBetPercent]),
    ]);

    const ix = {
      programId: PROGRAM_ID,
      keys: [
        { pubkey: tokenVaultPda, isSigner: false, isWritable: true },
        { pubkey: mintPubkey, isSigner: false, isWritable: false },
        { pubkey: vaultAtaPda, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: AgentCasino.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
      ],
      data: instructionData,
    };

    const tx = new Transaction().add(ix);
    return await this.provider.sendAndConfirm(tx);
  }

  /**
   * Add liquidity to a token vault
   * @param mint SPL token mint address
   * @param amount Amount of tokens to deposit (in base units)
   * @param providerAta Provider's associated token account (will be derived if not provided)
   */
  async tokenAddLiquidity(
    mint: string | PublicKey,
    amount: number,
    providerAta?: string | PublicKey
  ): Promise<string> {
    const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
    await this.initTokenLpPosition(mintPubkey);
    const { tokenVaultPda, vaultAtaPda } = this.deriveTokenVaultPdas(mintPubkey);

    const [lpPositionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('token_lp'), tokenVaultPda.toBuffer(), this.wallet.publicKey.toBuffer()],
      PROGRAM_ID
    );

    // If no provider ATA given, derive the standard ATA
    let providerAtaPubkey: PublicKey;
    if (providerAta) {
      providerAtaPubkey = typeof providerAta === 'string' ? new PublicKey(providerAta) : providerAta;
    } else {
      const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
      providerAtaPubkey = getAssociatedTokenAddressSync(mintPubkey, this.wallet.publicKey);
    }

    const discriminator = Buffer.from([0x51, 0x83, 0x1d, 0xe8, 0xba, 0xc9, 0xac, 0xcc]);
    const instructionData = Buffer.concat([
      discriminator,
      new BN(amount).toArrayLike(Buffer, 'le', 8),
    ]);

    const ix = {
      programId: PROGRAM_ID,
      keys: [
        { pubkey: tokenVaultPda, isSigner: false, isWritable: true },
        { pubkey: mintPubkey, isSigner: false, isWritable: false },
        { pubkey: vaultAtaPda, isSigner: false, isWritable: true },
        { pubkey: lpPositionPda, isSigner: false, isWritable: true },
        { pubkey: providerAtaPubkey, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: AgentCasino.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: instructionData,
    };

    const tx = new Transaction().add(ix);
    return await this.provider.sendAndConfirm(tx);
  }


  /**
   * Get token vault stats for a specific mint
   * @param mint SPL token mint address
   */
  async getTokenVaultStats(mint: string | PublicKey): Promise<TokenVaultStats> {
    const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
    const { tokenVaultPda } = this.deriveTokenVaultPdas(mintPubkey);

    const accountInfo = await this.connection.getAccountInfo(tokenVaultPda);
    if (!accountInfo) throw new Error('Token vault not found for this mint');

    const data = accountInfo.data;
    let offset = 8; // skip discriminator
    const authority = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    const mintAddr = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    const vaultAta = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    const pool = new BN(data.slice(offset, offset + 8), 'le'); offset += 8;
    const houseEdgeBps = data.readUInt16LE(offset); offset += 2;
    const minBet = new BN(data.slice(offset, offset + 8), 'le'); offset += 8;
    const maxBetPercent = data[offset]; offset += 1;
    const totalGames = new BN(data.slice(offset, offset + 8), 'le'); offset += 8;
    const totalVolume = new BN(data.slice(offset, offset + 8), 'le'); offset += 8;
    const totalPayout = new BN(data.slice(offset, offset + 8), 'le');

    return {
      authority: authority.toString(),
      mint: mintAddr.toString(),
      vaultAta: vaultAta.toString(),
      pool: pool.toNumber(),
      houseEdgeBps,
      minBet: minBet.toNumber(),
      maxBetPercent,
      totalGames: totalGames.toNumber(),
      totalVolume: totalVolume.toNumber(),
      totalPayout: totalPayout.toNumber(),
    };
  }

  // === Memory Slots Methods ===

  /**
   * Create a memory pool (authority only)
   * @param pullPriceSol Price to pull a random memory in SOL
   * @param houseEdgeBps House edge in basis points (e.g., 1000 = 10%)
   */
  async createMemoryPool(pullPriceSol: number, houseEdgeBps: number): Promise<string> {
    const pullPrice = Math.floor(pullPriceSol * LAMPORTS_PER_SOL);

    const discriminator = Buffer.from([0x18, 0xfa, 0x9d, 0xbd, 0x42, 0x88, 0x4e, 0x44]);
    const instructionData = Buffer.concat([
      discriminator,
      new BN(pullPrice).toArrayLike(Buffer, 'le', 8),
      Buffer.from(new Uint16Array([houseEdgeBps]).buffer),
    ]);

    const ix = {
      programId: PROGRAM_ID,
      keys: [
        { pubkey: this.memoryPoolPda, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: instructionData,
    };

    const tx = new Transaction().add(ix);
    return await this.provider.sendAndConfirm(tx);
  }

  /**
   * Deposit a memory into the pool
   * @param content Memory content (max 500 chars)
   * @param category Memory category
   * @param rarity Memory rarity claim
   */
  async depositMemory(
    content: string,
    category: MemoryCategory,
    rarity: MemoryRarity
  ): Promise<{ txSignature: string; memoryAddress: string }> {
    if (content.length === 0 || content.length > 500) {
      throw new Error('Memory content must be 1-500 characters');
    }

    const pool = await this.getMemoryPoolAccount();
    const memoryIndex = pool.totalMemories;

    const [memoryPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('memory'),
        this.memoryPoolPda.toBuffer(),
        new BN(memoryIndex).toArrayLike(Buffer, 'le', 8),
      ],
      PROGRAM_ID
    );

    // Encode category (0=Strategy, 1=Technical, 2=Alpha, 3=Random)
    const categoryMap: Record<MemoryCategory, number> = {
      Strategy: 0, Technical: 1, Alpha: 2, Random: 3,
    };
    const categoryByte = categoryMap[category];

    // Encode rarity (0=Common, 1=Rare, 2=Legendary)
    const rarityMap: Record<MemoryRarity, number> = {
      Common: 0, Rare: 1, Legendary: 2,
    };
    const rarityByte = rarityMap[rarity];

    // Encode content with length prefix
    const contentBytes = Buffer.from(content, 'utf8');
    const contentLenBuf = Buffer.alloc(4);
    contentLenBuf.writeUInt32LE(contentBytes.length);

    const discriminator = Buffer.from([0xb5, 0x09, 0xfd, 0x96, 0xc5, 0x2c, 0x3c, 0x51]);
    const instructionData = Buffer.concat([
      discriminator,
      contentLenBuf,
      contentBytes,
      Buffer.from([categoryByte]),
      Buffer.from([rarityByte]),
    ]);

    const ix = {
      programId: PROGRAM_ID,
      keys: [
        { pubkey: this.memoryPoolPda, isSigner: false, isWritable: true },
        { pubkey: memoryPda, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: instructionData,
    };

    const tx = new Transaction().add(ix);
    const signature = await this.provider.sendAndConfirm(tx);

    return {
      txSignature: signature,
      memoryAddress: memoryPda.toString(),
    };
  }

  /**
   * Pull a random memory from the pool
   * @param memoryAddress The memory PDA address to pull
   */
  async pullMemory(memoryAddress: string): Promise<MemoryPullResult> {
    const memoryPubkey = new PublicKey(memoryAddress);
    const clientSeed = this.generateClientSeed();

    // Fetch memory to get depositor
    const memory = await this.fetchMemory(memoryPubkey);

    const [pullRecordPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('mem_pull'),
        memoryPubkey.toBuffer(),
        this.wallet.publicKey.toBuffer(),
      ],
      PROGRAM_ID
    );

    const discriminator = Buffer.from([0x03, 0x2e, 0x7b, 0x92, 0x20, 0x40, 0x08, 0x3b]);
    const instructionData = Buffer.concat([
      discriminator,
      clientSeed,
    ]);

    const ix = {
      programId: PROGRAM_ID,
      keys: [
        { pubkey: this.housePda, isSigner: false, isWritable: true },
        { pubkey: this.memoryPoolPda, isSigner: false, isWritable: true },
        { pubkey: memoryPubkey, isSigner: false, isWritable: true },
        { pubkey: memory.depositor, isSigner: false, isWritable: true },
        { pubkey: pullRecordPda, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: instructionData,
    };

    const tx = new Transaction().add(ix);
    const signature = await this.provider.sendAndConfirm(tx);

    // Fetch pool for pricing info
    const pool = await this.getMemoryPoolAccount();
    const pullPrice = pool.pullPrice / LAMPORTS_PER_SOL;
    const houseTake = pullPrice * pool.houseEdgeBps / 10000;
    const depositorShare = pullPrice - houseTake;

    return {
      txSignature: signature,
      memory: await this.getMemory(memoryAddress),
      pullPrice,
      depositorShare,
      houseTake,
    };
  }

  /**
   * Rate a memory you pulled
   * @param memoryAddress The memory PDA address
   * @param rating Rating 1-5 (1-2 bad, 3 neutral, 4-5 good)
   */
  async rateMemory(memoryAddress: string, rating: number): Promise<string> {
    if (rating < 1 || rating > 5) {
      throw new Error('Rating must be 1-5');
    }

    const memoryPubkey = new PublicKey(memoryAddress);

    const [pullRecordPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('mem_pull'),
        memoryPubkey.toBuffer(),
        this.wallet.publicKey.toBuffer(),
      ],
      PROGRAM_ID
    );

    const discriminator = Buffer.from([0x4a, 0xb0, 0xd5, 0x1c, 0x28, 0x7f, 0x0e, 0x14]);
    const instructionData = Buffer.concat([
      discriminator,
      Buffer.from([rating]),
    ]);

    const ix = {
      programId: PROGRAM_ID,
      keys: [
        { pubkey: this.memoryPoolPda, isSigner: false, isWritable: true },
        { pubkey: memoryPubkey, isSigner: false, isWritable: true },
        { pubkey: pullRecordPda, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
      ],
      data: instructionData,
    };

    const tx = new Transaction().add(ix);
    return await this.provider.sendAndConfirm(tx);
  }

  /**
   * Withdraw an unpulled memory
   * @param memoryAddress The memory PDA address
   */
  async withdrawMemory(memoryAddress: string): Promise<{ txSignature: string; refund: number; fee: number }> {
    const memoryPubkey = new PublicKey(memoryAddress);

    // Read stake BEFORE withdrawal (stake is zeroed after tx)
    const memory = await this.fetchMemory(memoryPubkey);
    const stake = this.safeToNumber(memory.stake) / LAMPORTS_PER_SOL;
    const fee = stake * 0.05;
    const refund = stake - fee;

    const discriminator = Buffer.from([0x71, 0x47, 0x16, 0x1e, 0x2c, 0xa0, 0x71, 0x03]);
    const instructionData = discriminator;

    const ix = {
      programId: PROGRAM_ID,
      keys: [
        { pubkey: this.memoryPoolPda, isSigner: false, isWritable: true },
        { pubkey: memoryPubkey, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
      ],
      data: instructionData,
    };

    const tx = new Transaction().add(ix);
    const signature = await this.provider.sendAndConfirm(tx);

    return { txSignature: signature, refund, fee };
  }

  /**
   * Get memory pool stats
   */
  async getMemoryPool(): Promise<MemoryPoolStats> {
    const pool = await this.getMemoryPoolAccount();
    return {
      address: this.memoryPoolPda.toString(),
      authority: pool.authority.toString(),
      pullPrice: pool.pullPrice / LAMPORTS_PER_SOL,
      houseEdgeBps: pool.houseEdgeBps,
      stakeAmount: pool.stakeAmount / LAMPORTS_PER_SOL,
      totalMemories: this.safeToNumber(pool.totalMemories),
      totalPulls: this.safeToNumber(pool.totalPulls),
      poolBalance: pool.poolBalance / LAMPORTS_PER_SOL,
    };
  }

  /**
   * Get a specific memory by address
   */
  async getMemory(memoryAddress: string): Promise<MemoryData> {
    const memoryPubkey = new PublicKey(memoryAddress);
    const memory = await this.fetchMemory(memoryPubkey);
    return this.formatMemoryData(memoryAddress, memory);
  }

  /**
   * Get all memories deposited by a specific agent
   */
  async getMyMemories(): Promise<MemoryData[]> {
    return this.getMemoriesByDepositor(this.wallet.publicKey);
  }

  /**
   * Get memories deposited by a specific address
   */
  async getMemoriesByDepositor(depositor: PublicKey): Promise<MemoryData[]> {
    const pool = await this.getMemoryPoolAccount();
    const totalMemories = this.safeToNumber(pool.totalMemories);
    const memories: MemoryData[] = [];

    for (let i = 0; i < totalMemories; i++) {
      try {
        const [memoryPda] = PublicKey.findProgramAddressSync(
          [
            Buffer.from('memory'),
            this.memoryPoolPda.toBuffer(),
            new BN(i).toArrayLike(Buffer, 'le', 8),
          ],
          PROGRAM_ID
        );

        const memory = await this.fetchMemory(memoryPda);
        if (memory.depositor.equals(depositor)) {
          memories.push(this.formatMemoryData(memoryPda.toString(), memory));
        }
      } catch (e) {
        // Skip failed fetches
      }
    }

    return memories;
  }

  /**
   * Get all memories you've pulled
   */
  async getMyPulls(): Promise<MemoryPullRecord[]> {
    // Anchor discriminator for MemoryPull: sha256("account:MemoryPull")[0..8]
    const discriminator = createHash('sha256')
      .update(Buffer.from('account:MemoryPull'))
      .digest()
      .subarray(0, 8);

    const accounts = await this.connection.getProgramAccounts(PROGRAM_ID, {
      filters: [
        { memcmp: { offset: 0, bytes: bs58.encode(discriminator) } },
        { memcmp: { offset: 8, bytes: this.wallet.publicKey.toBase58() } },
      ],
    });

    return accounts.map(({ account }) => {
      const data = account.data;
      // Layout: 8 disc + 32 puller + 32 memory + 1 option_tag [+ 1 rating] + 8 timestamp + 1 bump
      const puller = new PublicKey(data.subarray(8, 40));
      const memory = new PublicKey(data.subarray(40, 72));
      const ratingTag = data[72];
      const rating = ratingTag === 1 ? data[73] : null;
      const tsOffset = ratingTag === 1 ? 74 : 73;
      const timestamp = Number(data.readBigInt64LE(tsOffset));
      return {
        puller: puller.toString(),
        memory: memory.toString(),
        rating,
        timestamp,
      };
    });
  }

  /**
   * Get list of active memories available to pull
   */
  async getActiveMemories(limit: number = 20): Promise<MemoryData[]> {
    const pool = await this.getMemoryPoolAccount();
    const totalMemories = this.safeToNumber(pool.totalMemories);
    const memories: MemoryData[] = [];

    for (let i = totalMemories - 1; i >= 0 && memories.length < limit; i--) {
      try {
        const [memoryPda] = PublicKey.findProgramAddressSync(
          [
            Buffer.from('memory'),
            this.memoryPoolPda.toBuffer(),
            new BN(i).toArrayLike(Buffer, 'le', 8),
          ],
          PROGRAM_ID
        );

        const memory = await this.fetchMemory(memoryPda);
        if (memory.active) {
          memories.push(this.formatMemoryData(memoryPda.toString(), memory));
        }
      } catch (e) {
        // Skip failed fetches
      }
    }

    return memories;
  }

  // === Memory Slots Private Helpers ===

  private async getMemoryPoolAccount(): Promise<any> {
    const accountInfo = await this.connection.getAccountInfo(this.memoryPoolPda);
    if (!accountInfo) throw new Error('Memory pool not initialized');
    return this.parseMemoryPoolAccount(accountInfo.data);
  }

  private parseMemoryPoolAccount(data: Buffer): any {
    let offset = 8; // Skip discriminator

    const authority = new PublicKey(data.slice(offset, offset + 32));
    offset += 32;

    const pullPrice = new BN(data.slice(offset, offset + 8), 'le').toNumber();
    offset += 8;

    const houseEdgeBps = data.readUInt16LE(offset);
    offset += 2;

    const stakeAmount = new BN(data.slice(offset, offset + 8), 'le').toNumber();
    offset += 8;

    const totalMemories = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;

    const totalPulls = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;

    const poolBalance = new BN(data.slice(offset, offset + 8), 'le').toNumber();

    return {
      authority,
      pullPrice,
      houseEdgeBps,
      stakeAmount,
      totalMemories,
      totalPulls,
      poolBalance,
    };
  }

  private async fetchMemory(pda: PublicKey): Promise<any> {
    const accountInfo = await this.connection.getAccountInfo(pda);
    if (!accountInfo) throw new Error('Memory not found');
    return this.parseMemoryAccount(accountInfo.data);
  }

  private parseMemoryAccount(data: Buffer): any {
    let offset = 8; // Skip discriminator

    const pool = new PublicKey(data.slice(offset, offset + 32));
    offset += 32;

    const depositor = new PublicKey(data.slice(offset, offset + 32));
    offset += 32;

    const index = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;

    // Content is 500 bytes fixed
    const contentBytes = data.slice(offset, offset + 500);
    offset += 500;

    const contentLength = data.readUInt16LE(offset);
    offset += 2;

    const content = contentBytes.slice(0, contentLength).toString('utf8');

    const category = data[offset];
    offset += 1;

    const rarity = data[offset];
    offset += 1;

    const stake = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;

    const timesPulled = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;

    const totalRating = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;

    const ratingCount = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;

    const active = data[offset] === 1;
    offset += 1;

    const createdAt = new BN(data.slice(offset, offset + 8), 'le');

    return {
      pool,
      depositor,
      index,
      content,
      category,
      rarity,
      stake,
      timesPulled,
      totalRating,
      ratingCount,
      active,
      createdAt,
    };
  }

  private formatMemoryData(address: string, memory: any): MemoryData {
    const categoryNames: MemoryCategory[] = ['Strategy', 'Technical', 'Alpha', 'Random'];
    const rarityNames: MemoryRarity[] = ['Common', 'Rare', 'Legendary'];

    const ratingCount = memory.ratingCount.toNumber();
    const averageRating = ratingCount > 0
      ? memory.totalRating.toNumber() / ratingCount
      : 0;

    return {
      address,
      pool: memory.pool.toString(),
      depositor: memory.depositor.toString(),
      index: memory.index.toNumber(),
      content: memory.content,
      category: categoryNames[memory.category] || 'Random',
      rarity: rarityNames[memory.rarity] || 'Common',
      stake: memory.stake.toNumber() / LAMPORTS_PER_SOL,
      timesPulled: memory.timesPulled.toNumber(),
      averageRating,
      ratingCount,
      active: memory.active,
      createdAt: memory.createdAt.toNumber(),
    };
  }

  // === Private Helpers ===

  /**
   * Safely convert BN to number, avoiding overflow for values > Number.MAX_SAFE_INTEGER
   * Returns the number if safe, throws if value exceeds safe integer range
   */
  private safeToNumber(bn: BN): number {
    if (bn.gt(new BN(Number.MAX_SAFE_INTEGER))) {
      // For display purposes, convert via string and parseFloat
      return parseFloat(bn.toString());
    }
    return bn.toNumber();
  }

  private generateClientSeed(): Buffer {
    return randomBytes(32);
  }

  private async getHouseAccount(): Promise<any> {
    const accountInfo = await this.connection.getAccountInfo(this.housePda);
    if (!accountInfo) throw new Error('House not initialized');
    
    // Parse house account data
    return this.parseHouseAccount(accountInfo.data);
  }

  private parseHouseAccount(data: Buffer): any {
    // Skip 8-byte discriminator
    let offset = 8;
    
    const authority = new PublicKey(data.slice(offset, offset + 32));
    offset += 32;
    
    const pool = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;
    
    const houseEdgeBps = data.readUInt16LE(offset);
    offset += 2;
    
    const minBet = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;
    
    const maxBetPercent = data[offset];
    offset += 1;
    
    const totalGames = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;
    
    const totalVolume = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;
    
    const totalPayout = new BN(data.slice(offset, offset + 8), 'le');

    return {
      authority,
      pool: pool.toNumber(),
      houseEdgeBps,
      minBet: minBet.toNumber(),
      maxBetPercent,
      totalGames,
      totalVolume,
      totalPayout,
    };
  }

  private async fetchGameRecord(pda: PublicKey): Promise<any> {
    const accountInfo = await this.connection.getAccountInfo(pda);
    if (!accountInfo) throw new Error('Game record not found');
    return this.parseGameRecord(accountInfo.data);
  }

  private parseGameRecord(data: Buffer): any {
    let offset = 8; // Skip discriminator
    
    const player = new PublicKey(data.slice(offset, offset + 32));
    offset += 32;
    
    const gameType = data[offset];
    offset += 1;
    
    const amount = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;
    
    const choice = data[offset];
    offset += 1;
    
    const result = data[offset];
    offset += 1;
    
    const payout = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;
    
    const serverSeed = data.slice(offset, offset + 32);
    offset += 32;
    
    const clientSeed = data.slice(offset, offset + 32);
    offset += 32;
    
    const timestamp = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;
    
    const slot = new BN(data.slice(offset, offset + 8), 'le');

    return {
      player,
      gameType,
      amount,
      choice,
      result,
      payout,
      serverSeed,
      clientSeed,
      timestamp,
      slot,
    };
  }

  private async fetchAgentStats(pda: PublicKey): Promise<any> {
    const accountInfo = await this.connection.getAccountInfo(pda);
    if (!accountInfo) throw new Error('Agent stats not found');
    return this.parseAgentStats(accountInfo.data);
  }

  private parseAgentStats(data: Buffer): any {
    let offset = 8; // Skip discriminator

    const agent = new PublicKey(data.slice(offset, offset + 32));
    offset += 32;

    const totalGames = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;

    const totalWagered = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;

    const totalWon = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;

    const wins = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;

    const losses = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;

    const pvpGames = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;

    const pvpWins = new BN(data.slice(offset, offset + 8), 'le');
    offset += 8;

    const bump = data[offset];

    return { agent, totalGames, totalWagered, totalWon, wins, losses, pvpGames, pvpWins, bump };
  }

  private parseGameType(type: number): 'CoinFlip' | 'DiceRoll' | 'Limbo' | 'Crash' {
    switch (type) {
      case 0: return 'CoinFlip';
      case 1: return 'DiceRoll';
      case 2: return 'Limbo';
      case 3: return 'Crash';
      default: return 'CoinFlip';
    }
  }

  // === PvP Challenge Methods ===

  /**
   * Create a PvP coin flip challenge for another agent to accept
   */
  async createChallenge(amountSol: number, choice: 'heads' | 'tails', nonce?: number): Promise<{ tx: string; challengeAddress: string }> {
    await this.loadProgram();
    const amount = new BN(amountSol * LAMPORTS_PER_SOL);
    const choiceVal = choice === 'heads' ? 0 : 1;
    const nonceBn = new BN(nonce ?? Date.now());

    const [challengePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("challenge"), this.wallet.publicKey.toBuffer(), nonceBn.toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID
    );

    const tx = await this.program.methods
      .createChallenge(amount, choiceVal, nonceBn)
      .accounts({
        house: this.housePda,
        challenge: challengePda,
        challenger: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { tx, challengeAddress: challengePda.toString() };
  }

  /**
   * Accept an open PvP challenge
   */
  async acceptChallenge(challengeAddress: string): Promise<{ tx: string; won: boolean; result: number }> {
    await this.loadProgram();
    const challengePda = new PublicKey(challengeAddress);
    const challenge = await this.program.account.challenge.fetch(challengePda);

    const [challengerStatsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), challenge.challenger.toBuffer()],
      PROGRAM_ID
    );
    const [acceptorStatsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), this.wallet.publicKey.toBuffer()],
      PROGRAM_ID
    );

    const clientSeed = Array.from(randomBytes(32));

    const tx = await this.program.methods
      .acceptChallenge(clientSeed)
      .accounts({
        house: this.housePda,
        challenge: challengePda,
        challenger: challenge.challenger,
        challengerStats: challengerStatsPda,
        acceptorStats: acceptorStatsPda,
        acceptor: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Fetch result
    await new Promise(r => setTimeout(r, 2000));
    const result = await this.program.account.challenge.fetch(challengePda);
    const won = result.winner.toString() === this.wallet.publicKey.toString();
    return { tx, won, result: result.result };
  }

  /**
   * Cancel your own open PvP challenge
   */
  async cancelChallenge(challengeAddress: string): Promise<string> {
    await this.loadProgram();
    const challengePda = new PublicKey(challengeAddress);
    return await this.program.methods
      .cancelChallenge()
      .accounts({
        challenge: challengePda,
        challenger: this.wallet.publicKey,
      })
      .rpc();
  }

  // === Price Prediction Methods ===

  /**
   * Create a price prediction bet (Pyth oracle-settled)
   */
  async createPricePrediction(
    asset: 'BTC' | 'SOL' | 'ETH',
    targetPrice: number,
    direction: 'above' | 'below',
    durationSeconds: number,
    amountSol: number,
    priceFeedAddress?: string
  ): Promise<{ tx: string; predictionAddress: string }> {
    await this.loadProgram();
    const assetEnum = { [asset.toLowerCase()]: {} };
    const directionEnum = { [direction]: {} };
    const targetPricePyth = new BN(Math.round(targetPrice * 1e8));
    const amount = new BN(amountSol * LAMPORTS_PER_SOL);

    // Default Pyth devnet feeds per asset
    const PYTH_FEEDS: Record<string, string> = {
      BTC: 'HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J',
      SOL: 'J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix',
      ETH: 'EdVCmQ9FSPcVe5YySXDPCRmc8aDQLKJ9xvYBMZPie1Vw',
    };
    const feedKey = new PublicKey(priceFeedAddress || PYTH_FEEDS[asset]);

    const houseAccount = await this.program.account.house.fetch(this.housePda);
    const gameCount = houseAccount.totalGames;

    const [predictionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("price_bet"), this.housePda.toBuffer(), gameCount.toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID
    );

    const tx = await this.program.methods
      .createPricePrediction(assetEnum, targetPricePyth, directionEnum, new BN(durationSeconds), amount, feedKey)
      .accounts({
        house: this.housePda,
        pricePrediction: predictionPda,
        creator: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { tx, predictionAddress: predictionPda.toString() };
  }

  /**
   * Take the opposite side of an existing price prediction
   */
  async takePricePrediction(predictionAddress: string): Promise<string> {
    await this.loadProgram();
    const predictionPda = new PublicKey(predictionAddress);
    const prediction = await this.program.account.pricePrediction.fetch(predictionPda);

    return await this.program.methods
      .takePricePrediction()
      .accounts({
        house: this.housePda,
        pricePrediction: predictionPda,
        taker: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /**
   * Settle a price prediction using Pyth oracle
   */
  async settlePricePrediction(predictionAddress: string, priceFeedAddress: string): Promise<string> {
    await this.loadProgram();
    const predictionPda = new PublicKey(predictionAddress);
    const prediction = await this.program.account.pricePrediction.fetch(predictionPda);

    return await this.program.methods
      .settlePricePrediction()
      .accounts({
        house: this.housePda,
        pricePrediction: predictionPda,
        priceFeed: new PublicKey(priceFeedAddress),
        creator: prediction.creator,
        taker: prediction.taker,
        settler: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /**
   * Cancel an unmatched price prediction (creator only)
   */
  async cancelPricePrediction(predictionAddress: string): Promise<string> {
    await this.loadProgram();
    const predictionPda = new PublicKey(predictionAddress);
    return await this.program.methods
      .cancelPricePrediction()
      .accounts({
        house: this.housePda,
        pricePrediction: predictionPda,
        creator: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  // === Prediction Market Methods ===

  /**
   * Create a prediction market with commit-reveal mechanism
   */
  async createPredictionMarket(
    question: string,
    outcomes: string[],
    commitDeadlineUnix: number,
    revealDeadlineUnix: number,
    marketId?: number
  ): Promise<{ tx: string; marketAddress: string }> {
    await this.loadProgram();
    const mId = new BN(marketId ?? Date.now());

    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pred_mkt"), mId.toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID
    );

    const tx = await this.program.methods
      .createPredictionMarket(mId, question, outcomes, new BN(commitDeadlineUnix), new BN(revealDeadlineUnix))
      .accounts({
        house: this.housePda,
        market: marketPda,
        authority: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { tx, marketAddress: marketPda.toString() };
  }

  /**
   * Commit a hidden bet to a prediction market (hash of choice + salt)
   */
  async commitPredictionBet(
    marketAddress: string,
    commitment: Buffer,
    amountSol: number
  ): Promise<{ tx: string; betAddress: string }> {
    await this.loadProgram();
    const marketPda = new PublicKey(marketAddress);

    const [betPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pred_bet"), marketPda.toBuffer(), this.wallet.publicKey.toBuffer()],
      PROGRAM_ID
    );

    const tx = await this.program.methods
      .commitPredictionBet(Array.from(commitment), new BN(amountSol * LAMPORTS_PER_SOL))
      .accounts({
        house: this.housePda,
        market: marketPda,
        bet: betPda,
        bettor: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { tx, betAddress: betPda.toString() };
  }

  /**
   * Start the reveal phase for a prediction market (authority only)
   */
  async startRevealPhase(marketAddress: string): Promise<string> {
    await this.loadProgram();
    const marketPda = new PublicKey(marketAddress);
    return await this.program.methods
      .startRevealPhase()
      .accounts({
        house: this.housePda,
        market: marketPda,
        authority: this.wallet.publicKey,
      })
      .rpc();
  }

  /**
   * Reveal your prediction bet (after commit phase ends)
   */
  async revealPredictionBet(
    marketAddress: string,
    predictedProject: string,
    salt: Buffer
  ): Promise<string> {
    await this.loadProgram();
    const marketPda = new PublicKey(marketAddress);

    const [betPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pred_bet"), marketPda.toBuffer(), this.wallet.publicKey.toBuffer()],
      PROGRAM_ID
    );

    return await this.program.methods
      .revealPredictionBet(predictedProject, Array.from(salt), new BN(0))
      .accounts({
        house: this.housePda,
        market: marketPda,
        bet: betPda,
        bettor: this.wallet.publicKey,
      })
      .rpc();
  }

  /**
   * Resolve a prediction market with the winning outcome (authority only)
   */
  async resolvePredictionMarket(
    marketAddress: string,
    winningProject: string
  ): Promise<string> {
    await this.loadProgram();
    const marketPda = new PublicKey(marketAddress);
    const market = await this.program.account.predictionMarket.fetch(marketPda);

    return await this.program.methods
      .resolvePredictionMarket(winningProject, market.totalPool)
      .accounts({
        house: this.housePda,
        market: marketPda,
        authority: this.wallet.publicKey,
      })
      .rpc();
  }

  /**
   * Claim prediction market winnings
   */
  async claimPredictionWinnings(marketAddress: string): Promise<string> {
    await this.loadProgram();
    const marketPda = new PublicKey(marketAddress);

    const [betPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pred_bet"), marketPda.toBuffer(), this.wallet.publicKey.toBuffer()],
      PROGRAM_ID
    );

    const [agentStatsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), this.wallet.publicKey.toBuffer()],
      PROGRAM_ID
    );

    return await this.program.methods
      .claimPredictionWinnings()
      .accounts({
        house: this.housePda,
        market: marketPda,
        bet: betPda,
        agentStats: agentStatsPda,
        winner: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  // === Lottery Methods ===

  /**
   * Create a new lottery pool
   * @param ticketPriceSol Price per ticket in SOL
   * @param maxTickets Maximum number of tickets (2-1000)
   * @param endSlot Slot number when ticket sales end
   */
  async createLottery(ticketPriceSol: number, maxTickets: number, endSlot: number): Promise<{ tx: string; lotteryAddress: string; lotteryIndex: number }> {
    await this.loadProgram();
    const ticketPrice = new BN(ticketPriceSol * LAMPORTS_PER_SOL);

    const houseAccount = await this.program.account.house.fetch(this.housePda);
    const lotteryIndex = (houseAccount as any).totalGames;

    const [lotteryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lottery"), this.housePda.toBuffer(), lotteryIndex.toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID
    );

    const tx = await this.program.methods
      .createLottery(ticketPrice, maxTickets, new BN(endSlot))
      .accounts({
        house: this.housePda,
        lottery: lotteryPda,
        creator: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { tx, lotteryAddress: lotteryPda.toString(), lotteryIndex: lotteryIndex.toNumber() };
  }

  /**
   * Buy a lottery ticket
   * @param lotteryAddress The lottery PDA address
   */
  async buyLotteryTicket(lotteryAddress: string): Promise<{ tx: string; ticketAddress: string; ticketNumber: number }> {
    await this.loadProgram();
    const lotteryPda = new PublicKey(lotteryAddress);
    const lottery = await this.program.account.lottery.fetch(lotteryPda);

    const ticketNumber = (lottery as any).ticketsSold;
    const [ticketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), lotteryPda.toBuffer(), new BN(ticketNumber).toArrayLike(Buffer, "le", 2)],
      PROGRAM_ID
    );

    const tx = await this.program.methods
      .buyLotteryTicket()
      .accounts({
        house: this.housePda,
        lottery: lotteryPda,
        ticket: ticketPda,
        buyer: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { tx, ticketAddress: ticketPda.toString(), ticketNumber };
  }

  /**
   * Draw a lottery winner using Switchboard VRF randomness
   * @param lotteryAddress The lottery PDA address
   * @param randomnessAccount Switchboard randomness account with revealed value
   */
  async drawLotteryWinner(lotteryAddress: string, randomnessAccount: string): Promise<{ tx: string; winnerTicket: number }> {
    await this.loadProgram();
    const lotteryPda = new PublicKey(lotteryAddress);

    const tx = await this.program.methods
      .drawLotteryWinner()
      .accounts({
        house: this.housePda,
        lottery: lotteryPda,
        randomnessAccount: new PublicKey(randomnessAccount),
        drawer: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const settled = await this.program.account.lottery.fetch(lotteryPda);
    return { tx, winnerTicket: (settled as any).winnerTicket };
  }

  /**
   * Claim lottery prize (winner only)
   * @param lotteryAddress The lottery PDA address
   * @param ticketNumber The winning ticket number
   */
  async claimLotteryPrize(lotteryAddress: string, ticketNumber: number): Promise<{ tx: string; prize: number }> {
    await this.loadProgram();
    const lotteryPda = new PublicKey(lotteryAddress);

    const [ticketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), lotteryPda.toBuffer(), new BN(ticketNumber).toArrayLike(Buffer, "le", 2)],
      PROGRAM_ID
    );

    const lottery = await this.program.account.lottery.fetch(lotteryPda);
    const prize = (lottery as any).prize.toNumber();

    const tx = await this.program.methods
      .claimLotteryPrize()
      .accounts({
        house: this.housePda,
        lottery: lotteryPda,
        ticket: ticketPda,
        winner: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { tx, prize: prize / LAMPORTS_PER_SOL };
  }

  async cancelLottery(lotteryAddress: string): Promise<{ tx: string }> {
    await this.loadProgram();
    const lotteryPda = new PublicKey(lotteryAddress);

    const tx = await this.program.methods
      .cancelLottery()
      .accounts({
        house: this.housePda,
        lottery: lotteryPda,
        canceller: this.wallet.publicKey,
      })
      .rpc();

    return { tx };
  }

  async refundLotteryTicket(lotteryAddress: string, ticketNumber: number, buyerAddress: string): Promise<{ tx: string }> {
    await this.loadProgram();
    const lotteryPda = new PublicKey(lotteryAddress);

    const [ticketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), lotteryPda.toBuffer(), new BN(ticketNumber).toArrayLike(Buffer, "le", 2)],
      PROGRAM_ID
    );

    const tx = await this.program.methods
      .refundLotteryTicket()
      .accounts({
        house: this.housePda,
        lottery: lotteryPda,
        ticket: ticketPda,
        buyer: new PublicKey(buyerAddress),
        refunder: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { tx };
  }

  /**
   * Get lottery info
   * @param lotteryAddress The lottery PDA address
   */
  async getLotteryInfo(lotteryAddress: string): Promise<{
    address: string;
    creator: string;
    ticketPrice: number;
    maxTickets: number;
    ticketsSold: number;
    totalPool: number;
    winnerTicket: number;
    status: string;
    endSlot: number;
    lotteryIndex: number;
    prize: number;
  }> {
    await this.loadProgram();
    const lotteryPda = new PublicKey(lotteryAddress);
    const lottery = await this.program.account.lottery.fetch(lotteryPda);
    const l = lottery as any;

    const statusMap: Record<number, string> = { 0: 'Open', 1: 'Drawing', 2: 'Settled', 3: 'Claimed', 4: 'Cancelled' };

    return {
      address: lotteryAddress,
      creator: l.creator.toString(),
      ticketPrice: l.ticketPrice.toNumber() / LAMPORTS_PER_SOL,
      maxTickets: l.maxTickets,
      ticketsSold: l.ticketsSold,
      totalPool: l.totalPool.toNumber() / LAMPORTS_PER_SOL,
      winnerTicket: l.winnerTicket,
      status: statusMap[l.status] || 'Unknown',
      endSlot: l.endSlot.toNumber(),
      lotteryIndex: l.lotteryIndex.toNumber(),
      prize: l.prize.toNumber() / LAMPORTS_PER_SOL,
    };
  }

  // === VRF Game Methods (Switchboard Randomness) ===

  /**
   * Request a VRF coin flip (2-step: request then settle)
   */
  async vrfCoinFlipRequest(amountSol: number, choice: 'heads' | 'tails', randomnessAccount: string): Promise<{ tx: string; vrfRequestAddress: string }> {
    await this.loadProgram();
    const amount = new BN(amountSol * LAMPORTS_PER_SOL);
    const choiceVal = choice === 'heads' ? 0 : 1;

    const houseAccount = await this.program.account.house.fetch(this.housePda);
    const [vrfRequestPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vrf_request"), this.wallet.publicKey.toBuffer(), houseAccount.totalGames.toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID
    );

    const tx = await this.program.methods
      .vrfCoinFlipRequest(amount, choiceVal)
      .accounts({
        house: this.housePda,
        vrfRequest: vrfRequestPda,
        randomnessAccount: new PublicKey(randomnessAccount),
        player: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { tx, vrfRequestAddress: vrfRequestPda.toString() };
  }

  /**
   * Settle a VRF coin flip after Switchboard randomness is ready
   */
  async vrfCoinFlipSettle(vrfRequestAddress: string, randomnessAccount: string): Promise<{ tx: string; won: boolean; payout: number }> {
    await this.loadProgram();
    const vrfRequestPda = new PublicKey(vrfRequestAddress);
    const vrfRequest = await this.program.account.vrfRequest.fetch(vrfRequestPda);

    const [agentStatsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), vrfRequest.player.toBuffer()],
      PROGRAM_ID
    );

    const tx = await this.program.methods
      .vrfCoinFlipSettle()
      .accounts({
        house: this.housePda,
        vrfRequest: vrfRequestPda,
        agentStats: agentStatsPda,
        randomnessAccount: new PublicKey(randomnessAccount),
        player: vrfRequest.player,
        settler: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const settled = await this.program.account.vrfRequest.fetch(vrfRequestPda);
    return { tx, won: settled.payout.toNumber() > 0, payout: settled.payout.toNumber() / LAMPORTS_PER_SOL };
  }

  /**
   * Request a VRF dice roll
   */
  async vrfDiceRollRequest(amountSol: number, target: number, randomnessAccount: string): Promise<{ tx: string; vrfRequestAddress: string }> {
    await this.loadProgram();
    const amount = new BN(amountSol * LAMPORTS_PER_SOL);

    const houseAccount = await this.program.account.house.fetch(this.housePda);
    const [vrfRequestPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vrf_dice"), this.wallet.publicKey.toBuffer(), houseAccount.totalGames.toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID
    );

    const tx = await this.program.methods
      .vrfDiceRollRequest(amount, target)
      .accounts({
        house: this.housePda,
        vrfRequest: vrfRequestPda,
        randomnessAccount: new PublicKey(randomnessAccount),
        player: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { tx, vrfRequestAddress: vrfRequestPda.toString() };
  }

  /**
   * Settle a VRF dice roll
   */
  async vrfDiceRollSettle(vrfRequestAddress: string, randomnessAccount: string): Promise<{ tx: string; won: boolean; payout: number; result: number }> {
    await this.loadProgram();
    const vrfRequestPda = new PublicKey(vrfRequestAddress);
    const vrfRequest = await this.program.account.vrfRequest.fetch(vrfRequestPda);

    const [agentStatsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), vrfRequest.player.toBuffer()],
      PROGRAM_ID
    );

    const tx = await this.program.methods
      .vrfDiceRollSettle()
      .accounts({
        house: this.housePda,
        vrfRequest: vrfRequestPda,
        agentStats: agentStatsPda,
        randomnessAccount: new PublicKey(randomnessAccount),
        player: vrfRequest.player,
        settler: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const settled = await this.program.account.vrfRequest.fetch(vrfRequestPda);
    return { tx, won: settled.payout.toNumber() > 0, payout: settled.payout.toNumber() / LAMPORTS_PER_SOL, result: settled.result };
  }

  /**
   * Request a VRF limbo game
   */
  async vrfLimboRequest(amountSol: number, targetMultiplier: number, randomnessAccount: string): Promise<{ tx: string; vrfRequestAddress: string }> {
    await this.loadProgram();
    const amount = new BN(amountSol * LAMPORTS_PER_SOL);
    const multiplier = Math.round(targetMultiplier * 100); // Convert 2.5x to 250

    const houseAccount = await this.program.account.house.fetch(this.housePda);
    const [vrfRequestPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vrf_limbo"), this.wallet.publicKey.toBuffer(), houseAccount.totalGames.toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID
    );

    const tx = await this.program.methods
      .vrfLimboRequest(amount, multiplier)
      .accounts({
        house: this.housePda,
        vrfRequest: vrfRequestPda,
        randomnessAccount: new PublicKey(randomnessAccount),
        player: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { tx, vrfRequestAddress: vrfRequestPda.toString() };
  }

  /**
   * Settle a VRF limbo game
   */
  async vrfLimboSettle(vrfRequestAddress: string, randomnessAccount: string): Promise<{ tx: string; won: boolean; payout: number }> {
    await this.loadProgram();
    const vrfRequestPda = new PublicKey(vrfRequestAddress);
    const vrfRequest = await this.program.account.vrfRequest.fetch(vrfRequestPda);

    const [agentStatsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), vrfRequest.player.toBuffer()],
      PROGRAM_ID
    );

    const tx = await this.program.methods
      .vrfLimboSettle()
      .accounts({
        house: this.housePda,
        vrfRequest: vrfRequestPda,
        agentStats: agentStatsPda,
        randomnessAccount: new PublicKey(randomnessAccount),
        player: vrfRequest.player,
        settler: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const settled = await this.program.account.vrfRequest.fetch(vrfRequestPda);
    return { tx, won: settled.payout.toNumber() > 0, payout: settled.payout.toNumber() / LAMPORTS_PER_SOL };
  }

  /**
   * Request a VRF crash game
   */
  async vrfCrashRequest(amountSol: number, cashoutMultiplier: number, randomnessAccount: string): Promise<{ tx: string; vrfRequestAddress: string }> {
    await this.loadProgram();
    const amount = new BN(amountSol * LAMPORTS_PER_SOL);
    const multiplier = Math.round(cashoutMultiplier * 100); // Convert 2.5x to 250

    const houseAccount = await this.program.account.house.fetch(this.housePda);
    const [vrfRequestPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vrf_crash"), this.wallet.publicKey.toBuffer(), houseAccount.totalGames.toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID
    );

    const tx = await this.program.methods
      .vrfCrashRequest(amount, multiplier)
      .accounts({
        house: this.housePda,
        vrfRequest: vrfRequestPda,
        randomnessAccount: new PublicKey(randomnessAccount),
        player: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { tx, vrfRequestAddress: vrfRequestPda.toString() };
  }

  /**
   * Settle a VRF crash game
   */
  async vrfCrashSettle(vrfRequestAddress: string, randomnessAccount: string): Promise<{ tx: string; won: boolean; payout: number }> {
    await this.loadProgram();
    const vrfRequestPda = new PublicKey(vrfRequestAddress);
    const vrfRequest = await this.program.account.vrfRequest.fetch(vrfRequestPda);

    const [agentStatsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), vrfRequest.player.toBuffer()],
      PROGRAM_ID
    );

    const tx = await this.program.methods
      .vrfCrashSettle()
      .accounts({
        house: this.housePda,
        vrfRequest: vrfRequestPda,
        agentStats: agentStatsPda,
        randomnessAccount: new PublicKey(randomnessAccount),
        player: vrfRequest.player,
        settler: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const settled = await this.program.account.vrfRequest.fetch(vrfRequestPda);
    return { tx, won: settled.payout.toNumber() > 0, payout: settled.payout.toNumber() / LAMPORTS_PER_SOL };
  }

  private formatGameResult(
    signature: string,
    record: any,
    clientSeed: Buffer
  ): GameResult {
    const won = record.payout.toNumber() > 0;
    
    return {
      txSignature: signature,
      won,
      payout: record.payout.toNumber() / LAMPORTS_PER_SOL,
      result: record.result,
      choice: record.choice,
      serverSeed: Buffer.from(record.serverSeed).toString('hex'),
      clientSeed: clientSeed.toString('hex'),
      verificationHash: createHash('sha256')
        .update(Buffer.concat([record.serverSeed, clientSeed]))
        .digest('hex'),
      slot: record.slot.toNumber(),
    };
  }
}

// === Hitman Market Re-export ===
export { HitmanMarket, type Hit, type HitPoolStats } from './hitman';

// === Helper Classes ===

class KeypairWallet implements Wallet {
  constructor(readonly payer: Keypair) {}

  get publicKey(): PublicKey {
    return this.payer.publicKey;
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if ('partialSign' in tx) {
      tx.partialSign(this.payer);
    }
    return tx;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    return txs.map((tx) => {
      if ('partialSign' in tx) {
        tx.partialSign(this.payer);
      }
      return tx;
    });
  }
}

// === AgentWallet Integration ===

// Re-export AgentWallet utilities for hackathon compliance
export {
  loadAgentWalletConfig,
  getAgentWalletAddress,
  isAgentWalletConfigured,
  getAgentWalletBalances,
  transferSolana as agentWalletTransfer,
  signMessage as agentWalletSignMessage,
  printSetupInstructions as printAgentWalletSetup,
  type AgentWalletConfig,
} from './agentwallet';

/**
 * Get the recommended wallet address for Agent Casino
 * Uses AgentWallet if configured (hackathon compliant), falls back to provided keypair
 */
export function getRecommendedWalletAddress(fallbackKeypair?: Keypair): string | null {
  // Prefer AgentWallet (hackathon requirement)
  const agentWalletAddress = require('./agentwallet').getAgentWalletAddress();
  if (agentWalletAddress) {
    return agentWalletAddress;
  }
  // Fallback to local keypair (not recommended for production)
  return fallbackKeypair?.publicKey.toString() || null;
}

// === Jupiter Exports ===

export { jupiterSwapToSol, JupiterSwapResult } from './jupiter';

// === Exports ===

export default AgentCasino;
