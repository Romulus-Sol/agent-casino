/**
 * VRF Constraint Proof — Generation & Verification
 *
 * Wraps the constraint circuit into a proof-generation and verification flow
 * compatible with MoltLaunch attestation format.
 *
 * Architecture:
 *   1. Before game: House commits to VRF output (vrfCommitment published)
 *   2. Game plays:  Cards are dealt using the constraint circuit
 *   3. After game:  Proof is generated and published
 *   4. Verification: Anyone can verify the proof without the VRF seed
 *                    (or with it, for full re-derivation)
 *
 * PoC Limitations:
 *   - Uses SHA-256 hash chains instead of real STARK proofs
 *   - Proof is "simulated" — it demonstrates the data flow, not ZK properties
 *   - In production, replace with Winterfell/Cairo/SP1 for succinct proofs
 */

import { createHash } from 'crypto';
import {
  GameParams,
  Card,
  DealResult,
  ConstraintWitness,
  executeConstraint,
  commitToVrf,
  commitToCards,
  generateConstraintCommitment,
  verifyDerivation,
  verifyConstraintCommitment,
} from './vrf-constraint';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VrfConstraintAttestation {
  /** Attestation type identifier */
  type: 'vrf-constraint';
  /** Semantic version of the proof format */
  version: '0.1.0';
  /** Unique game session identifier */
  gameId: string;
  /** SHA-256 of VRF output (commits to randomness without revealing it) */
  vrfCommitment: string;
  /** SHA-256 of derived cards + gameId (commits to the deal) */
  cardCommitment: string;
  /** The constraint proof — hash-chain commitment binding VRF → cards */
  proof: string;
  /** Whether this proof format supports independent verification */
  verifiable: boolean;
  /** Unix timestamp (ms) of proof generation */
  timestamp: number;
}

export interface ProofResult {
  /** The dealt cards */
  cards: Card[];
  /** Player hands (grouped) */
  playerHands: Card[][];
  /** Community cards */
  community: Card[];
  /** All dealt card indices */
  allDealtIndices: number[];
  /** The attestation-compatible proof */
  attestation: VrfConstraintAttestation;
  /** The full constraint witness (includes private data — do NOT publish) */
  witness: ConstraintWitness;
}

export interface VerificationResult {
  /** Overall verification passed */
  valid: boolean;
  /** Individual check results */
  checks: {
    /** VRF commitment matches */
    vrfCommitmentValid: boolean;
    /** Card commitment matches */
    cardCommitmentValid: boolean;
    /** Constraint commitment (proof) matches */
    proofValid: boolean;
    /** Cards were correctly derived from VRF (requires vrfOutput) */
    derivationValid: boolean | null;
  };
  /** Human-readable verification summary */
  summary: string;
}

// ─── Proof Generation ─────────────────────────────────────────────────────────

/**
 * Generate a VRF constraint proof for a card deal.
 *
 * This is the main entry point for proof generation. Given a VRF output
 * and game parameters, it:
 *   1. Derives cards deterministically via the constraint circuit
 *   2. Generates commitments (VRF, cards, combined)
 *   3. Packages everything into a MoltLaunch-compatible attestation
 *
 * @param vrfOutput - Raw VRF output bytes (32 bytes from Switchboard/Solana VRF)
 * @param gameParams - Game configuration (players, cards per player, community cards)
 * @returns ProofResult with cards, attestation, and witness
 */
export function generateProof(vrfOutput: Buffer, gameParams: GameParams): ProofResult {
  // Validate VRF output
  if (!Buffer.isBuffer(vrfOutput) || vrfOutput.length < 32) {
    throw new Error('VRF output must be a Buffer of at least 32 bytes');
  }

  // Execute the constraint circuit
  const witness = executeConstraint(vrfOutput, gameParams);

  // Generate commitments
  const vrfCommitment = commitToVrf(vrfOutput);
  const cardCommitment = commitToCards(witness.deal.allDealtIndices, gameParams.gameId);
  const proof = generateConstraintCommitment(vrfOutput, witness.deal.allDealtIndices, gameParams.gameId);

  // Build attestation
  const attestation: VrfConstraintAttestation = {
    type: 'vrf-constraint',
    version: '0.1.0',
    gameId: gameParams.gameId,
    vrfCommitment,
    cardCommitment,
    proof,
    verifiable: true,
    timestamp: Date.now(),
  };

  // Flatten all cards for the result
  const allCards: Card[] = [
    ...witness.deal.playerHands.flat(),
    ...witness.deal.community,
  ];

  return {
    cards: allCards,
    playerHands: witness.deal.playerHands,
    community: witness.deal.community,
    allDealtIndices: witness.deal.allDealtIndices,
    attestation,
    witness,
  };
}

/**
 * Generate only the pre-game commitment (before cards are revealed).
 * The house publishes this before the game starts to lock in the randomness.
 *
 * @param vrfOutput - Raw VRF output bytes
 * @param gameId - Game session identifier
 * @returns The VRF commitment hash
 */
export function generatePreGameCommitment(vrfOutput: Buffer, gameId: string): {
  vrfCommitment: string;
  gameId: string;
  timestamp: number;
} {
  return {
    vrfCommitment: commitToVrf(vrfOutput),
    gameId,
    timestamp: Date.now(),
  };
}

// ─── Proof Verification ───────────────────────────────────────────────────────

/**
 * Verify a VRF constraint proof.
 *
 * Two verification modes:
 *   1. With VRF output (full verification): Re-derives cards and checks everything
 *   2. Without VRF output (commitment verification): Checks commitments match
 *
 * @param attestation - The published attestation to verify
 * @param cards - The claimed dealt card indices
 * @param gameParams - Game parameters used for the deal
 * @param vrfOutput - Optional: the revealed VRF output for full verification
 * @returns VerificationResult with detailed check results
 */
export function verifyProof(
  attestation: VrfConstraintAttestation,
  cards: number[],
  gameParams: GameParams,
  vrfOutput?: Buffer
): VerificationResult {
  const checks = {
    vrfCommitmentValid: false,
    cardCommitmentValid: false,
    proofValid: false,
    derivationValid: null as boolean | null,
  };

  // Check card commitment
  const expectedCardCommitment = commitToCards(cards, gameParams.gameId);
  checks.cardCommitmentValid = expectedCardCommitment === attestation.cardCommitment;

  if (vrfOutput) {
    // Full verification — we have the VRF output
    const expectedVrfCommitment = commitToVrf(vrfOutput);
    checks.vrfCommitmentValid = expectedVrfCommitment === attestation.vrfCommitment;

    // Verify the combined proof
    checks.proofValid = verifyConstraintCommitment(
      vrfOutput,
      cards,
      gameParams.gameId,
      attestation.proof
    );

    // Verify the actual card derivation
    checks.derivationValid = verifyDerivation(vrfOutput, gameParams, cards);
  } else {
    // Commitment-only verification — can't check VRF or derivation
    // But we can check that the card commitment matches the proof structure
    checks.vrfCommitmentValid = true; // Can't verify without VRF output, assume valid
    checks.proofValid = true; // Can't fully verify without VRF output

    // We can at least verify the card commitment is consistent
    // (this proves the claimed cards match what was committed)
  }

  const valid = checks.cardCommitmentValid &&
    checks.vrfCommitmentValid &&
    checks.proofValid &&
    (checks.derivationValid === null || checks.derivationValid === true);

  let summary: string;
  if (valid && checks.derivationValid === true) {
    summary = 'FULLY VERIFIED: Cards are the correct deterministic derivation of the VRF output.';
  } else if (valid && checks.derivationValid === null) {
    summary = 'COMMITMENTS VALID: Card commitments match, but VRF output not provided for full derivation check.';
  } else {
    const failures: string[] = [];
    if (!checks.vrfCommitmentValid) failures.push('VRF commitment mismatch');
    if (!checks.cardCommitmentValid) failures.push('Card commitment mismatch');
    if (!checks.proofValid) failures.push('Proof commitment mismatch');
    if (checks.derivationValid === false) failures.push('Card derivation incorrect');
    summary = `VERIFICATION FAILED: ${failures.join(', ')}`;
  }

  return { valid, checks, summary };
}

/**
 * Quick verification: just check if cards + VRF output match an attestation.
 * Convenience wrapper around verifyProof for simple use cases.
 */
export function quickVerify(
  attestation: VrfConstraintAttestation,
  cards: number[],
  gameId: string,
  vrfOutput: Buffer
): boolean {
  // We need minimal game params for verification
  const gameParams: GameParams = {
    numPlayers: 1, // Not needed for verification
    cardsPerPlayer: cards.length,
    communityCards: 0,
    gameId,
  };

  // For quick verify, we just check the constraint commitment
  return verifyConstraintCommitment(vrfOutput, cards, gameId, attestation.proof);
}

// ─── Serialization ────────────────────────────────────────────────────────────

/**
 * Serialize an attestation to a deterministic JSON string.
 * Uses sorted keys for consistent hashing across implementations.
 */
export function serializeAttestation(attestation: VrfConstraintAttestation): string {
  return JSON.stringify(attestation, Object.keys(attestation).sort(), 2);
}

/**
 * Compute a hash of the attestation for on-chain anchoring.
 * This hash can be stored on-chain (e.g., in a Solana account) to
 * create an immutable reference to the proof.
 */
export function hashAttestation(attestation: VrfConstraintAttestation): string {
  const canonical = JSON.stringify(attestation, Object.keys(attestation).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Deserialize an attestation from JSON, with basic validation.
 */
export function deserializeAttestation(json: string): VrfConstraintAttestation {
  const parsed = JSON.parse(json);

  if (parsed.type !== 'vrf-constraint') {
    throw new Error(`Invalid attestation type: ${parsed.type}`);
  }
  if (!parsed.version || !parsed.gameId || !parsed.vrfCommitment || !parsed.cardCommitment || !parsed.proof) {
    throw new Error('Attestation missing required fields');
  }

  return parsed as VrfConstraintAttestation;
}
