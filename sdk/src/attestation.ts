/**
 * Attestation Formatter for Agent Casino
 *
 * Produces standardized ExecutionAttestation JSON from on-chain game data.
 * Designed for cross-protocol interop — any agent framework can verify
 * game outcomes without importing the full SDK.
 *
 * The attestation_hash is a SHA-256 of the canonical sorted-key JSON,
 * so any consumer can recompute and verify independently.
 */

import { createHash } from 'crypto';
import { PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';

export const ATTESTATION_VERSION = '1.0.0';
export const ATTESTATION_PROTOCOL = 'agent-casino';

const GAME_TYPES = ['CoinFlip', 'DiceRoll', 'Limbo', 'PvPChallenge', 'Crash'] as const;
const VRF_STATUSES = ['Pending', 'Settled', 'Expired'] as const;

export type AttestationGameType = typeof GAME_TYPES[number];
export type AttestationVrfStatus = typeof VRF_STATUSES[number];

export interface ExecutionAttestation {
  version: string;
  protocol: string;
  network: 'devnet' | 'mainnet-beta';
  program_id: string;

  // Game identity
  game_index: number;
  game_type: AttestationGameType;

  // Participants
  player: string;
  house: string;

  // Game parameters
  bet_lamports: number;
  choice: number;
  target_multiplier?: number;  // limbo/crash only (human-readable, e.g. 2.5)

  // Outcome
  result: number;
  payout_lamports: number;
  won: boolean;

  // Timing
  created_at: number;
  settled_at: number;
  request_slot: number;

  // VRF proof reference
  vrf_randomness_account: string;
  vrf_status: AttestationVrfStatus;

  // Verification — SHA-256 of canonical JSON of all fields above (sorted keys)
  attestation_hash: string;
}

export interface ParsedVrfRequest {
  player: PublicKey;
  house: PublicKey;
  randomnessAccount: PublicKey;
  gameType: number;
  amount: BN;
  choice: number;
  targetMultiplier: number;
  status: number;
  createdAt: BN;
  settledAt: BN;
  result: number;
  payout: BN;
  gameIndex: BN;
  requestSlot: BN;
}

/**
 * Compute the attestation hash from all fields except attestation_hash itself.
 * Uses canonical JSON (sorted keys, no whitespace) for deterministic hashing.
 */
function computeAttestationHash(attestation: Omit<ExecutionAttestation, 'attestation_hash'>): string {
  const canonical = JSON.stringify(attestation, Object.keys(attestation).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Format on-chain VrfRequest data into a standardized ExecutionAttestation.
 */
export function formatAttestation(
  vrfData: ParsedVrfRequest,
  network: 'devnet' | 'mainnet-beta' = 'devnet',
  programId: string
): ExecutionAttestation {
  const partial: Record<string, any> = {
    version: ATTESTATION_VERSION,
    protocol: ATTESTATION_PROTOCOL,
    network,
    program_id: programId,
    game_index: vrfData.gameIndex.toNumber(),
    game_type: GAME_TYPES[vrfData.gameType] || 'CoinFlip',
    player: vrfData.player.toString(),
    house: vrfData.house.toString(),
    bet_lamports: vrfData.amount.toNumber(),
    choice: vrfData.choice,
    result: vrfData.result,
    payout_lamports: vrfData.payout.toNumber(),
    won: vrfData.payout.toNumber() > 0,
    created_at: vrfData.createdAt.toNumber(),
    settled_at: vrfData.settledAt.toNumber(),
    request_slot: vrfData.requestSlot.toNumber(),
    vrf_randomness_account: vrfData.randomnessAccount.toString(),
    vrf_status: VRF_STATUSES[vrfData.status] || 'Pending',
  };

  // Only include target_multiplier for limbo/crash (non-zero)
  if (vrfData.targetMultiplier > 0) {
    partial.target_multiplier = vrfData.targetMultiplier / 100;
  }

  // Remove undefined fields for clean canonical hash
  for (const key of Object.keys(partial)) {
    if (partial[key] === undefined) delete partial[key];
  }

  const attestation_hash = computeAttestationHash(partial as Omit<ExecutionAttestation, 'attestation_hash'>);

  return { ...partial, attestation_hash } as ExecutionAttestation;
}

/**
 * Verify an attestation hash independently — no SDK needed.
 * Recomputes SHA-256 of canonical JSON and compares.
 */
export function verifyAttestationHash(attestation: ExecutionAttestation): boolean {
  const { attestation_hash, ...rest } = attestation;
  return computeAttestationHash(rest) === attestation_hash;
}

/**
 * Parse a VrfRequest account from raw bytes (Borsh-serialized after 8-byte Anchor discriminator).
 *
 * Byte layout (total 159 bytes):
 *   [0-7]     discriminator
 *   [8-39]    player (Pubkey, 32)
 *   [40-71]   house (Pubkey, 32)
 *   [72-103]  randomness_account (Pubkey, 32)
 *   [104]     game_type (u8 enum: 0=CoinFlip, 1=DiceRoll, 2=Limbo, 3=PvP, 4=Crash)
 *   [105-112] amount (u64 LE)
 *   [113]     choice (u8)
 *   [114-115] target_multiplier (u16 LE)
 *   [116]     status (u8 enum: 0=Pending, 1=Settled, 2=Expired)
 *   [117-124] created_at (i64 LE)
 *   [125-132] settled_at (i64 LE)
 *   [133]     result (u8)
 *   [134-141] payout (u64 LE)
 *   [142-149] game_index (u64 LE)
 *   [150-157] request_slot (u64 LE)
 *   [158]     bump (u8)
 */
export function parseVrfRequestRaw(data: Buffer): ParsedVrfRequest {
  let offset = 8; // skip Anchor discriminator
  const player = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const house = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const randomnessAccount = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const gameType = data[offset]; offset += 1;
  const amount = new BN(data.subarray(offset, offset + 8), 'le'); offset += 8;
  const choice = data[offset]; offset += 1;
  const targetMultiplier = data.readUInt16LE(offset); offset += 2;
  const status = data[offset]; offset += 1;
  const createdAt = new BN(data.subarray(offset, offset + 8), 'le'); offset += 8;
  const settledAt = new BN(data.subarray(offset, offset + 8), 'le'); offset += 8;
  const result = data[offset]; offset += 1;
  const payout = new BN(data.subarray(offset, offset + 8), 'le'); offset += 8;
  const gameIndex = new BN(data.subarray(offset, offset + 8), 'le'); offset += 8;
  const requestSlot = new BN(data.subarray(offset, offset + 8), 'le'); offset += 8;

  return {
    player, house, randomnessAccount, gameType, amount, choice,
    targetMultiplier, status, createdAt, settledAt, result, payout,
    gameIndex, requestSlot,
  };
}
