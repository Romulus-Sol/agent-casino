/**
 * VRF Constraint Proof Module
 *
 * Proves that card deals in Agent Casino are deterministically derived
 * from VRF output. Designed for MoltLaunch attestation integration.
 *
 * @example
 * ```typescript
 * import { generateProof, verifyProof } from '@agent-casino/sdk/vrf-proof';
 * import { randomBytes } from 'crypto';
 *
 * // Simulate VRF output (in production, this comes from Switchboard/Solana VRF)
 * const vrfOutput = randomBytes(32);
 *
 * // Generate proof for a Texas Hold'em deal
 * const result = generateProof(vrfOutput, {
 *   numPlayers: 6,
 *   cardsPerPlayer: 2,
 *   communityCards: 5,
 *   gameId: 'game-001',
 * });
 *
 * // Publish attestation (safe — contains no secrets)
 * console.log(result.attestation);
 *
 * // Later: verify the proof (with VRF output for full verification)
 * const verification = verifyProof(
 *   result.attestation,
 *   result.allDealtIndices,
 *   { numPlayers: 6, cardsPerPlayer: 2, communityCards: 5, gameId: 'game-001' },
 *   vrfOutput
 * );
 * console.log(verification.summary);
 * ```
 */

// Constraint circuit — deterministic card derivation
export {
  // Core types
  type GameParams,
  type Card,
  type DealResult,
  type ConstraintWitness,

  // Card utilities
  indexToCard,
  cardToIndex,

  // Constraint execution
  executeConstraint,
  expandVrfOutput,
  deriveCards,

  // Commitment functions
  commitToVrf,
  commitToCards,
  generateConstraintCommitment,

  // Verification
  verifyDerivation,
  verifyConstraintCommitment,
} from './vrf-constraint';

// Proof generation & verification
export {
  // Types
  type VrfConstraintAttestation,
  type ProofResult,
  type VerificationResult,

  // Main API
  generateProof,
  generatePreGameCommitment,
  verifyProof,
  quickVerify,

  // Serialization
  serializeAttestation,
  hashAttestation,
  deserializeAttestation,
} from './vrf-proof';
