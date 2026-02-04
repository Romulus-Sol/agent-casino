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
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { Program, AnchorProvider, BN, Wallet } from '@coral-xyz/anchor';
import { randomBytes, createHash } from 'crypto';

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

export interface BettingContext {
  betMultiplier: number;
  riskScore: number;
  recommendation: string;
  warnings: string[];
  memecoinMania: string;
  timestamp: number;
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
  gameType: 'CoinFlip' | 'DiceRoll' | 'Limbo';
  amount: number;
  choice: number;
  result: number;
  payout: number;
  timestamp: number;
  slot: number;
}

// === Main SDK Class ===

export class AgentCasino {
  private connection: Connection;
  private wallet: Wallet;
  private provider: AnchorProvider;
  private housePda: PublicKey;
  private vaultPda: PublicKey;
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
        ...Buffer.from([0x1e, 0x0a, 0x18, 0x51, 0x45, 0x94, 0x2a, 0x17]),
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
        recommendation: 'Risk provider not configured',
        warnings: [],
        memecoinMania: 'unknown',
        timestamp: Date.now(),
      };
    }

    try {
      const response = await fetch('https://wargames-api.vercel.app/live/betting-context');
      const data = await response.json();

      // Apply multiplier caps from config
      let multiplier = data.bet_multiplier || 1.0;
      const maxMult = this.config.maxRiskMultiplier || 2.0;
      const minMult = this.config.minRiskMultiplier || 0.3;
      multiplier = Math.max(minMult, Math.min(maxMult, multiplier));

      this.cachedBettingContext = {
        betMultiplier: multiplier,
        riskScore: data.risk_score || 50,
        recommendation: data.recommendation || 'No recommendation',
        warnings: data.signals?.warnings || [],
        memecoinMania: data.signals?.memecoin_mania || 'unknown',
        timestamp: Date.now(),
      };
      this.contextCacheTime = Date.now();

      return this.cachedBettingContext;
    } catch (e) {
      // Fallback to neutral on API failure
      return {
        betMultiplier: 1.0,
        riskScore: 50,
        recommendation: 'WARGAMES API unavailable - using neutral settings',
        warnings: ['api_unavailable'],
        memecoinMania: 'unknown',
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
      const { adjustedBet, context } = await this.getRiskAdjustedBet(baseBetSol);
      const result = await this.coinFlip(adjustedBet, choice);
      return { ...result, riskContext: context };
    }
    return this.coinFlip(baseBetSol, choice);
  }

  /**
   * Dice roll with automatic risk adjustment
   */
  async smartDiceRoll(baseBetSol: number, target: DiceTarget): Promise<GameResult & { riskContext?: BettingContext }> {
    if (this.config.riskProvider === 'wargames') {
      const { adjustedBet, context } = await this.getRiskAdjustedBet(baseBetSol);
      const result = await this.diceRoll(adjustedBet, target);
      return { ...result, riskContext: context };
    }
    return this.diceRoll(baseBetSol, target);
  }

  /**
   * Limbo with automatic risk adjustment
   */
  async smartLimbo(baseBetSol: number, targetMultiplier: number): Promise<GameResult & { riskContext?: BettingContext }> {
    if (this.config.riskProvider === 'wargames') {
      const { adjustedBet, context } = await this.getRiskAdjustedBet(baseBetSol);
      const result = await this.limbo(adjustedBet, targetMultiplier);
      return { ...result, riskContext: context };
    }
    return this.limbo(baseBetSol, targetMultiplier);
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

    return { agent, totalGames, totalWagered, totalWon, wins, losses };
  }

  private parseGameType(type: number): 'CoinFlip' | 'DiceRoll' | 'Limbo' {
    switch (type) {
      case 0: return 'CoinFlip';
      case 1: return 'DiceRoll';
      case 2: return 'Limbo';
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
      coinFlip: Buffer.from([0x8a, 0x2c, 0x1d, 0x87, 0x54, 0x12, 0xf3, 0x01]),
      diceRoll: Buffer.from([0x9b, 0x3d, 0x2e, 0x98, 0x65, 0x23, 0x04, 0x12]),
      limbo: Buffer.from([0xac, 0x4e, 0x3f, 0xa9, 0x76, 0x34, 0x15, 0x23]),
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

  async signTransaction<T extends Transaction>(tx: T): Promise<T> {
    tx.partialSign(this.payer);
    return tx;
  }

  async signAllTransactions<T extends Transaction>(txs: T[]): Promise<T[]> {
    return txs.map((tx) => {
      tx.partialSign(this.payer);
      return tx;
    });
  }
}

// === Exports ===

export default AgentCasino;
