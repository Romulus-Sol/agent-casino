import { Connection, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

export interface HitPoolStats {
  authority: PublicKey;
  houseEdgeBps: number;
  totalHits: number;
  totalCompleted: number;
  totalBountiesPaid: number;
}

export interface Hit {
  pda: PublicKey;
  index: number;
  pool: PublicKey;
  poster: PublicKey;
  targetDescription: string;
  condition: string;
  bounty: number;
  hunter: PublicKey | null;
  proofLink: string | null;
  anonymous: boolean;
  status: "open" | "claimed" | "pendingVerification" | "disputed" | "completed" | "cancelled";
  createdAt: Date;
  claimedAt: Date | null;
  completedAt: Date | null;
  hunterStake: number;
}

export class HitmanMarket {
  private connection: Connection;
  private wallet: any;
  private program: Program;
  private hitPoolPda: PublicKey;
  private hitVaultPda: PublicKey;

  constructor(connection: Connection, wallet: any) {
    this.connection = connection;
    this.wallet = wallet;

    // Derive PDAs
    [this.hitPoolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("hit_pool")],
      PROGRAM_ID
    );
    [this.hitVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("hit_vault"), this.hitPoolPda.toBuffer()],
      PROGRAM_ID
    );
  }

  async initialize(program: Program) {
    this.program = program;
  }

  get poolPda(): PublicKey {
    return this.hitPoolPda;
  }

  get vaultPda(): PublicKey {
    return this.hitVaultPda;
  }

  /**
   * Get the hit pool statistics
   */
  async getPoolStats(): Promise<HitPoolStats> {
    const pool = await (this.program.account as any).hitPool.fetch(this.hitPoolPda);
    return {
      authority: pool.authority,
      houseEdgeBps: pool.houseEdgeBps,
      totalHits: pool.totalHits.toNumber(),
      totalCompleted: pool.totalCompleted.toNumber(),
      totalBountiesPaid: pool.totalBountiesPaid.toNumber() / LAMPORTS_PER_SOL,
    };
  }

  /**
   * Get a hit by index
   */
  async getHit(index: number): Promise<Hit> {
    const hitIndexBuffer = Buffer.alloc(8);
    hitIndexBuffer.writeBigUInt64LE(BigInt(index));
    const [hitPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("hit"), this.hitPoolPda.toBuffer(), hitIndexBuffer],
      PROGRAM_ID
    );

    const hit = await (this.program.account as any).hit.fetch(hitPda);
    return this.parseHit(hitPda, index, hit);
  }

  /**
   * Get all hits with optional status filter
   */
  async getHits(statusFilter?: string): Promise<Hit[]> {
    const poolStats = await this.getPoolStats();
    const hits: Hit[] = [];

    for (let i = 0; i < poolStats.totalHits; i++) {
      try {
        const hit = await this.getHit(i);
        if (!statusFilter || hit.status === statusFilter) {
          hits.push(hit);
        }
      } catch (e) {
        // Hit might be closed or invalid
      }
    }

    return hits;
  }

  /**
   * Create a new hit (bounty)
   */
  async createHit(
    targetDescription: string,
    condition: string,
    bountySOL: number,
    anonymous: boolean = false
  ): Promise<{ signature: string; hitPda: PublicKey }> {
    const poolStats = await this.getPoolStats();
    const hitIndex = poolStats.totalHits;

    const hitIndexBuffer = Buffer.alloc(8);
    hitIndexBuffer.writeBigUInt64LE(BigInt(hitIndex));
    const [hitPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("hit"), this.hitPoolPda.toBuffer(), hitIndexBuffer],
      PROGRAM_ID
    );

    const bountyLamports = new BN(Math.floor(bountySOL * LAMPORTS_PER_SOL));

    const tx = await this.program.methods
      .createHit(targetDescription, condition, bountyLamports, anonymous)
      .accountsPartial({
        hitPool: this.hitPoolPda,
        hit: hitPda,
        hitVault: this.hitVaultPda,
        poster: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { signature: tx, hitPda };
  }

  /**
   * Claim a hit (become the hunter)
   */
  async claimHit(hitIndex: number, stakeSOL: number): Promise<string> {
    const hitIndexBuffer = Buffer.alloc(8);
    hitIndexBuffer.writeBigUInt64LE(BigInt(hitIndex));
    const [hitPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("hit"), this.hitPoolPda.toBuffer(), hitIndexBuffer],
      PROGRAM_ID
    );

    const stakeLamports = new BN(Math.floor(stakeSOL * LAMPORTS_PER_SOL));

    const tx = await this.program.methods
      .claimHit(stakeLamports)
      .accountsPartial({
        hitPool: this.hitPoolPda,
        hit: hitPda,
        hitVault: this.hitVaultPda,
        hunter: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return tx;
  }

  /**
   * Submit proof that the hit was completed
   */
  async submitProof(hitIndex: number, proofLink: string): Promise<string> {
    const hitIndexBuffer = Buffer.alloc(8);
    hitIndexBuffer.writeBigUInt64LE(BigInt(hitIndex));
    const [hitPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("hit"), this.hitPoolPda.toBuffer(), hitIndexBuffer],
      PROGRAM_ID
    );

    const tx = await this.program.methods
      .submitProof(proofLink)
      .accountsPartial({
        hit: hitPda,
        hunter: this.wallet.publicKey,
      })
      .rpc();

    return tx;
  }

  /**
   * Verify a completed hit (poster only)
   */
  async verifyHit(hitIndex: number, approved: boolean, hunterPubkey: PublicKey): Promise<string> {
    const hitIndexBuffer = Buffer.alloc(8);
    hitIndexBuffer.writeBigUInt64LE(BigInt(hitIndex));
    const [hitPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("hit"), this.hitPoolPda.toBuffer(), hitIndexBuffer],
      PROGRAM_ID
    );

    const tx = await this.program.methods
      .verifyHit(approved)
      .accountsPartial({
        hitPool: this.hitPoolPda,
        hit: hitPda,
        hitVault: this.hitVaultPda,
        hunter: hunterPubkey,
        poster: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return tx;
  }

  /**
   * Cancel an unclaimed hit (poster only)
   */
  async cancelHit(hitIndex: number): Promise<string> {
    const hitIndexBuffer = Buffer.alloc(8);
    hitIndexBuffer.writeBigUInt64LE(BigInt(hitIndex));
    const [hitPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("hit"), this.hitPoolPda.toBuffer(), hitIndexBuffer],
      PROGRAM_ID
    );

    const tx = await this.program.methods
      .cancelHit()
      .accountsPartial({
        hitPool: this.hitPoolPda,
        hit: hitPda,
        hitVault: this.hitVaultPda,
        poster: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return tx;
  }

  private parseHit(pda: PublicKey, index: number, hit: any): Hit {
    const statusKey = Object.keys(hit.status)[0];
    const statusMap: Record<string, Hit["status"]> = {
      open: "open",
      claimed: "claimed",
      pendingVerification: "pendingVerification",
      disputed: "disputed",
      completed: "completed",
      cancelled: "cancelled",
    };

    return {
      pda,
      index,
      pool: hit.pool,
      poster: hit.poster,
      targetDescription: hit.targetDescription,
      condition: hit.condition,
      bounty: hit.bounty.toNumber() / LAMPORTS_PER_SOL,
      hunter: hit.hunter || null,
      proofLink: hit.proofLink || null,
      anonymous: hit.anonymous,
      status: statusMap[statusKey] || "open",
      createdAt: new Date(hit.createdAt.toNumber() * 1000),
      claimedAt: hit.claimedAt ? new Date(hit.claimedAt.toNumber() * 1000) : null,
      completedAt: hit.completedAt ? new Date(hit.completedAt.toNumber() * 1000) : null,
      hunterStake: hit.hunterStake.toNumber() / LAMPORTS_PER_SOL,
    };
  }
}
