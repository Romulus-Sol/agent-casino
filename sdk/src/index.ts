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
  VersionedTransaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { Program, AnchorProvider, BN, Wallet } from '@coral-xyz/anchor';
import { randomBytes, createHash } from 'crypto';
import { jupiterSwapToSol, JupiterSwapResult } from './jupiter';

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
  private vaultPda: PublicKey;
  private memoryPoolPda: PublicKey;
  private config: CasinoConfig;
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
    [this.vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), this.housePda.toBuffer()],
      programId
    );
    [this.memoryPoolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('memory_pool')],
      programId
    );
  }

  // === Game Methods ===

  /**
   * Flip a coin - 50/50 odds
   * @param amountSol Amount to bet in SOL
   * @param choice 'heads' or 'tails'
   * @returns Game result with verification data
   */
  async coinFlip(amountSol: number, choice: CoinChoice): Promise<GameResult> {
    const clientSeed = this.generateClientSeed();
    const choiceNum = choice === 'heads' ? 0 : 1;
    const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

    const house = await this.getHouseAccount();
    const gameIndex = house.totalGames;

    const [gameRecordPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('game'),
        this.housePda.toBuffer(),
        new BN(gameIndex).toArrayLike(Buffer, 'le', 8),
      ],
      PROGRAM_ID
    );

    const [agentStatsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), this.wallet.publicKey.toBuffer()],
      PROGRAM_ID
    );

    // Build and send transaction
    const tx = await this.buildGameTransaction(
      'coinFlip',
      amountLamports,
      choiceNum,
      clientSeed,
      gameRecordPda,
      agentStatsPda
    );

    const signature = await this.provider.sendAndConfirm(tx);
    
    // Fetch result
    const gameRecord = await this.fetchGameRecord(gameRecordPda);
    
    return this.formatGameResult(signature, gameRecord, clientSeed);
  }

  /**
   * Roll dice - choose a target, win if roll <= target
   * Lower target = higher payout, lower chance
   * @param amountSol Amount to bet in SOL
   * @param target Target number (1-5)
   * @returns Game result with verification data
   */
  async diceRoll(amountSol: number, target: DiceTarget): Promise<GameResult> {
    const clientSeed = this.generateClientSeed();
    const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

    const house = await this.getHouseAccount();
    const gameIndex = house.totalGames;

    const [gameRecordPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('game'),
        this.housePda.toBuffer(),
        new BN(gameIndex).toArrayLike(Buffer, 'le', 8),
      ],
      PROGRAM_ID
    );

    const [agentStatsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), this.wallet.publicKey.toBuffer()],
      PROGRAM_ID
    );

    const tx = await this.buildGameTransaction(
      'diceRoll',
      amountLamports,
      target,
      clientSeed,
      gameRecordPda,
      agentStatsPda
    );

    const signature = await this.provider.sendAndConfirm(tx);
    const gameRecord = await this.fetchGameRecord(gameRecordPda);
    
    return this.formatGameResult(signature, gameRecord, clientSeed);
  }

  /**
   * Limbo - set a target multiplier, win if result >= target
   * @param amountSol Amount to bet in SOL
   * @param targetMultiplier Target multiplier (1.01x - 100x)
   * @returns Game result with verification data
   */
  async limbo(amountSol: number, targetMultiplier: number): Promise<GameResult> {
    if (targetMultiplier < 1.01 || targetMultiplier > 100) {
      throw new Error('Target multiplier must be between 1.01 and 100');
    }

    const clientSeed = this.generateClientSeed();
    const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
    const targetBps = Math.floor(targetMultiplier * 100);

    const house = await this.getHouseAccount();
    const gameIndex = house.totalGames;

    const [gameRecordPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('game'),
        this.housePda.toBuffer(),
        new BN(gameIndex).toArrayLike(Buffer, 'le', 8),
      ],
      PROGRAM_ID
    );

    const [agentStatsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), this.wallet.publicKey.toBuffer()],
      PROGRAM_ID
    );

    const tx = await this.buildGameTransaction(
      'limbo',
      amountLamports,
      targetBps,
      clientSeed,
      gameRecordPda,
      agentStatsPda
    );

    const signature = await this.provider.sendAndConfirm(tx);
    const gameRecord = await this.fetchGameRecord(gameRecordPda);

    return this.formatGameResult(signature, gameRecord, clientSeed);
  }

  /**
   * Play crash - set your cashout multiplier and hope the game doesn't crash before you cash out
   * Most games crash early (1x-3x) but occasionally can go very high (50x+)
   * @param amountSol Amount to bet in SOL
   * @param cashoutMultiplier Target cashout multiplier (1.01 to 100)
   * @returns Game result with crash point
   */
  async crash(amountSol: number, cashoutMultiplier: number): Promise<GameResult> {
    if (cashoutMultiplier < 1.01 || cashoutMultiplier > 100) {
      throw new Error('Cashout multiplier must be between 1.01 and 100');
    }

    const clientSeed = this.generateClientSeed();
    const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
    const cashoutBps = Math.floor(cashoutMultiplier * 100);

    const house = await this.getHouseAccount();
    const gameIndex = house.totalGames;

    const [gameRecordPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('game'),
        this.housePda.toBuffer(),
        new BN(gameIndex).toArrayLike(Buffer, 'le', 8),
      ],
      PROGRAM_ID
    );

    const [agentStatsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), this.wallet.publicKey.toBuffer()],
      PROGRAM_ID
    );

    const tx = await this.buildGameTransaction(
      'crash',
      amountLamports,
      cashoutBps,
      clientSeed,
      gameRecordPda,
      agentStatsPda
    );

    const signature = await this.provider.sendAndConfirm(tx);
    const gameRecord = await this.fetchGameRecord(gameRecordPda);

    return this.formatGameResult(signature, gameRecord, clientSeed);
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
      totalGames: house.totalGames.toNumber(),
      totalVolume: house.totalVolume.toNumber() / LAMPORTS_PER_SOL,
      totalPayout: house.totalPayout.toNumber() / LAMPORTS_PER_SOL,
      houseProfit: (house.totalVolume.toNumber() - house.totalPayout.toNumber()) / LAMPORTS_PER_SOL,
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
      const profit = (stats.totalWon.toNumber() - stats.totalWagered.toNumber()) / LAMPORTS_PER_SOL;
      const wageredSol = stats.totalWagered.toNumber() / LAMPORTS_PER_SOL;

      return {
        agent: agent.toString(),
        totalGames: stats.totalGames.toNumber(),
        totalWagered: wageredSol,
        totalWon: stats.totalWon.toNumber() / LAMPORTS_PER_SOL,
        wins: stats.wins.toNumber(),
        losses: stats.losses.toNumber(),
        winRate: stats.totalGames.toNumber() > 0 
          ? (stats.wins.toNumber() / stats.totalGames.toNumber()) * 100 
          : 0,
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
    const totalGames = house.totalGames.toNumber();
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
          amount: record.amount.toNumber() / LAMPORTS_PER_SOL,
          choice: record.choice,
          result: record.result,
          payout: record.payout.toNumber() / LAMPORTS_PER_SOL,
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
        { pubkey: this.vaultPda, isSigner: false, isWritable: true },
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
  async smartCoinFlip(baseBetSol: number, choice: CoinChoice): Promise<GameResult & { riskContext?: BettingContext }> {
    if (this.config.riskProvider === 'wargames') {
      const context = await this.getBettingContext();
      const mult = context.gameMultipliers?.coinFlip ?? context.betMultiplier;
      const adjustedBet = baseBetSol * mult;
      const result = await this.coinFlip(adjustedBet, choice);
      return { ...result, riskContext: context };
    }
    return this.coinFlip(baseBetSol, choice);
  }

  /**
   * Dice roll with automatic risk adjustment
   * Scales more aggressively in high-volatility environments
   */
  async smartDiceRoll(baseBetSol: number, target: DiceTarget): Promise<GameResult & { riskContext?: BettingContext }> {
    if (this.config.riskProvider === 'wargames') {
      const context = await this.getBettingContext();
      const mult = context.gameMultipliers?.diceRoll ?? context.betMultiplier;
      const adjustedBet = baseBetSol * mult;
      const result = await this.diceRoll(adjustedBet, target);
      return { ...result, riskContext: context };
    }
    return this.diceRoll(baseBetSol, target);
  }

  /**
   * Limbo with automatic risk adjustment
   * Factors in volatility + liquidity stress for high-multiplier targets
   */
  async smartLimbo(baseBetSol: number, targetMultiplier: number): Promise<GameResult & { riskContext?: BettingContext }> {
    if (this.config.riskProvider === 'wargames') {
      const context = await this.getBettingContext();
      const mult = context.gameMultipliers?.limbo ?? context.betMultiplier;
      const adjustedBet = baseBetSol * mult;
      const result = await this.limbo(adjustedBet, targetMultiplier);
      return { ...result, riskContext: context };
    }
    return this.limbo(baseBetSol, targetMultiplier);
  }

  /**
   * Crash with automatic risk adjustment
   * Most aggressive scaling — factors in volatility + flash crash probability + liquidity
   */
  async smartCrash(baseBetSol: number, targetMultiplier: number): Promise<GameResult & { riskContext?: BettingContext }> {
    if (this.config.riskProvider === 'wargames') {
      const context = await this.getBettingContext();
      const mult = context.gameMultipliers?.crash ?? context.betMultiplier;
      const adjustedBet = baseBetSol * mult;
      const result = await this.crash(adjustedBet, targetMultiplier);
      return { ...result, riskContext: context };
    }
    return this.crash(baseBetSol, targetMultiplier);
  }

  // === Jupiter Auto-Swap Methods ===

  /**
   * Swap any SPL token to SOL via Jupiter, then play coin flip.
   * On devnet, uses mock swap (Jupiter only supports mainnet).
   * @param inputMint - SPL token mint address (e.g., USDC)
   * @param tokenAmount - Amount in token base units (e.g., 1000000 = 1 USDC)
   * @param choice - 'heads' or 'tails'
   */
  async swapAndCoinFlip(inputMint: string, tokenAmount: number, choice: CoinChoice): Promise<SwapAndPlayResult> {
    const swap = await this.jupiterSwap(inputMint, tokenAmount);
    if (swap.mock) {
      console.warn(`[AgentCasino] Mock swap: no actual token swap performed. Using ${swap.solAmount} SOL from wallet.`);
    }
    try {
      const result = await this.coinFlip(swap.solAmount, choice);
      return { ...result, swap };
    } catch (err: any) {
      throw new Error(`Swap succeeded (${swap.signature}) but game failed: ${err.message}. SOL from swap is in your wallet.`);
    }
  }

  /**
   * Swap any SPL token to SOL via Jupiter, then play dice roll.
   */
  async swapAndDiceRoll(inputMint: string, tokenAmount: number, target: DiceTarget): Promise<SwapAndPlayResult> {
    const swap = await this.jupiterSwap(inputMint, tokenAmount);
    if (swap.mock) {
      console.warn(`[AgentCasino] Mock swap: no actual token swap performed. Using ${swap.solAmount} SOL from wallet.`);
    }
    try {
      const result = await this.diceRoll(swap.solAmount, target);
      return { ...result, swap };
    } catch (err: any) {
      throw new Error(`Swap succeeded (${swap.signature}) but game failed: ${err.message}. SOL from swap is in your wallet.`);
    }
  }

  /**
   * Swap any SPL token to SOL via Jupiter, then play limbo.
   */
  async swapAndLimbo(inputMint: string, tokenAmount: number, targetMultiplier: number): Promise<SwapAndPlayResult> {
    const swap = await this.jupiterSwap(inputMint, tokenAmount);
    if (swap.mock) {
      console.warn(`[AgentCasino] Mock swap: no actual token swap performed. Using ${swap.solAmount} SOL from wallet.`);
    }
    try {
      const result = await this.limbo(swap.solAmount, targetMultiplier);
      return { ...result, swap };
    } catch (err: any) {
      throw new Error(`Swap succeeded (${swap.signature}) but game failed: ${err.message}. SOL from swap is in your wallet.`);
    }
  }

  /**
   * Swap any SPL token to SOL via Jupiter, then play crash.
   */
  async swapAndCrash(inputMint: string, tokenAmount: number, cashoutMultiplier: number): Promise<SwapAndPlayResult> {
    const swap = await this.jupiterSwap(inputMint, tokenAmount);
    if (swap.mock) {
      console.warn(`[AgentCasino] Mock swap: no actual token swap performed. Using ${swap.solAmount} SOL from wallet.`);
    }
    try {
      const result = await this.crash(swap.solAmount, cashoutMultiplier);
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
  verifyResult(
    serverSeed: string,
    clientSeed: string,
    playerPubkey: string,
    expectedResult: number
  ): boolean {
    const combined = Buffer.concat([
      Buffer.from(serverSeed, 'hex'),
      Buffer.from(clientSeed, 'hex'),
      new PublicKey(playerPubkey).toBuffer(),
    ]);

    const hash = createHash('sha256').update(combined).digest();
    const computedResult = hash[0] % 2; // For coin flip

    return computedResult === expectedResult;
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
   * Play a coin flip with SPL tokens
   * @param mint SPL token mint address
   * @param amount Bet amount in token base units
   * @param choice 'heads' or 'tails'
   * @param playerAta Player's associated token account (will be derived if not provided)
   */
  async tokenCoinFlip(
    mint: string | PublicKey,
    amount: number,
    choice: CoinChoice,
    playerAta?: string | PublicKey
  ): Promise<TokenGameResult> {
    const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
    const { tokenVaultPda, vaultAtaPda } = this.deriveTokenVaultPdas(mintPubkey);
    const choiceNum = choice === 'heads' ? 0 : 1;
    const clientSeed = this.generateClientSeed();

    // Fetch vault to get game index
    const vaultAccount = await this.connection.getAccountInfo(tokenVaultPda);
    if (!vaultAccount) throw new Error('Token vault not found for this mint');
    const totalGames = new BN(vaultAccount.data.slice(8 + 32 + 32 + 32 + 8 + 2 + 8 + 1, 8 + 32 + 32 + 32 + 8 + 2 + 8 + 1 + 8), 'le');

    const gameIndexBuffer = totalGames.toArrayLike(Buffer, 'le', 8);
    const [gameRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('token_game'), tokenVaultPda.toBuffer(), gameIndexBuffer],
      PROGRAM_ID
    );

    const [agentStatsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), this.wallet.publicKey.toBuffer()],
      PROGRAM_ID
    );

    // Derive player ATA if not provided
    let playerAtaPubkey: PublicKey;
    if (playerAta) {
      playerAtaPubkey = typeof playerAta === 'string' ? new PublicKey(playerAta) : playerAta;
    } else {
      const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
      playerAtaPubkey = getAssociatedTokenAddressSync(mintPubkey, this.wallet.publicKey);
    }

    const discriminator = Buffer.from([0x05, 0x5b, 0x10, 0x19, 0x47, 0x52, 0x71, 0xef]);
    const instructionData = Buffer.concat([
      discriminator,
      new BN(amount).toArrayLike(Buffer, 'le', 8),
      Buffer.from([choiceNum]),
      clientSeed,
    ]);

    const ix = {
      programId: PROGRAM_ID,
      keys: [
        { pubkey: tokenVaultPda, isSigner: false, isWritable: true },
        { pubkey: mintPubkey, isSigner: false, isWritable: false },
        { pubkey: vaultAtaPda, isSigner: false, isWritable: true },
        { pubkey: gameRecordPda, isSigner: false, isWritable: true },
        { pubkey: agentStatsPda, isSigner: false, isWritable: true },
        { pubkey: playerAtaPubkey, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: AgentCasino.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: instructionData,
    };

    const tx = new Transaction().add(ix);
    const txSignature = await this.provider.sendAndConfirm(tx);

    // Parse game record
    const gameAccount = await this.connection.getAccountInfo(gameRecordPda);
    if (gameAccount) {
      const data = gameAccount.data;
      let offset = 8; // skip discriminator
      offset += 32; // player
      offset += 32; // mint
      const gameType = data[offset]; offset += 1;
      const betAmount = new BN(data.slice(offset, offset + 8), 'le'); offset += 8;
      const resultChoice = data[offset]; offset += 1;
      const result = data[offset]; offset += 1;
      const payout = new BN(data.slice(offset, offset + 8), 'le'); offset += 8;
      const serverSeed = data.slice(offset, offset + 32); offset += 32;
      const parsedClientSeed = data.slice(offset, offset + 32); offset += 32;
      const timestamp = new BN(data.slice(offset, offset + 8), 'le'); offset += 8;
      const slot = new BN(data.slice(offset, offset + 8), 'le');

      return {
        txSignature,
        won: payout.toNumber() > 0,
        payout: payout.toNumber(),
        result,
        choice: choiceNum,
        mint: mintPubkey.toString(),
        serverSeed: Buffer.from(serverSeed).toString('hex'),
        clientSeed: Buffer.from(parsedClientSeed).toString('hex'),
        slot: slot.toNumber(),
      };
    }

    return {
      txSignature,
      won: false,
      payout: 0,
      result: -1,
      choice: choiceNum,
      mint: mintPubkey.toString(),
      serverSeed: '',
      clientSeed: clientSeed.toString('hex'),
      slot: 0,
    };
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

    // Calculate refund (95% of stake, 5% fee)
    const memory = await this.fetchMemory(memoryPubkey);
    const stake = memory.stake.toNumber() / LAMPORTS_PER_SOL;
    const fee = stake * 0.05;
    const refund = stake - fee;

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
      totalMemories: pool.totalMemories.toNumber(),
      totalPulls: pool.totalPulls.toNumber(),
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
    const totalMemories = pool.totalMemories.toNumber();
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
    // This would require scanning or maintaining an index
    // For now, return empty array - full implementation would need getProgramAccounts
    return [];
  }

  /**
   * Get list of active memories available to pull
   */
  async getActiveMemories(limit: number = 20): Promise<MemoryData[]> {
    const pool = await this.getMemoryPoolAccount();
    const totalMemories = pool.totalMemories.toNumber();
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

  private async buildGameTransaction(
    method: string,
    amount: number,
    choice: number,
    clientSeed: Buffer,
    gameRecordPda: PublicKey,
    agentStatsPda: PublicKey
  ): Promise<Transaction> {
    // This would use the actual program IDL in production
    // For now, we build the instruction manually
    const discriminators: Record<string, Buffer> = {
      coinFlip: Buffer.from([0xe5, 0x7c, 0x1f, 0x02, 0xa6, 0x8b, 0x22, 0xf8]),
      diceRoll: Buffer.from([0xea, 0x49, 0x6c, 0xd7, 0x8c, 0x3c, 0x9c, 0x5a]),
      limbo: Buffer.from([0xa0, 0xbf, 0x98, 0x88, 0x67, 0xcf, 0xd6, 0x9f]),
      crash: Buffer.from([0x70, 0xba, 0x37, 0x35, 0x24, 0x26, 0x2b, 0x6e]),
    };

    const instructionData = Buffer.concat([
      discriminators[method],
      new BN(amount).toArrayLike(Buffer, 'le', 8),
      Buffer.from([choice]),
      clientSeed,
    ]);

    const ix = {
      programId: PROGRAM_ID,
      keys: [
        { pubkey: this.housePda, isSigner: false, isWritable: true },
        { pubkey: this.vaultPda, isSigner: false, isWritable: true },
        { pubkey: gameRecordPda, isSigner: false, isWritable: true },
        { pubkey: agentStatsPda, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: instructionData,
    };

    return new Transaction().add(ix);
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
