# VRF Constraint Circuit — Proof of Concept

**Provably fair card dealing for Agent Casino, powered by VRF.**

## What This Proves

Given a VRF output (random bytes from Solana VRF / Switchboard), this module proves that:

1. **Deterministic derivation**: The dealt cards are the *only* valid output of the constraint circuit for the given VRF output and game parameters.
2. **No duplicates**: The Fisher-Yates shuffle guarantees no card appears twice.
3. **Commitment binding**: A pre-game commitment locks the house into a specific random seed *before* cards are revealed.
4. **Post-game verifiability**: Anyone with the VRF output can independently re-derive the cards and confirm they match.

In plain English: **The house can't cheat.** The cards are locked in by the VRF before the game starts, and anyone can verify this after.

## What This Doesn't Prove (Yet)

This is a **proof of concept**. Here's what's simulated vs. real:

| Feature | Status | Notes |
|---------|--------|-------|
| Deterministic card derivation | ✅ Real | Fisher-Yates on VRF bytes |
| SHA-256 commitments | ✅ Real | Standard cryptographic commitments |
| Pre-game VRF commitment | ✅ Real | Locks randomness before dealing |
| Post-game verification | ✅ Real | Full re-derivation check |
| **Succinct ZK/STARK proof** | ❌ Simulated | Uses hash chain, not a real STARK |
| **On-chain proof verification** | ❌ Not implemented | Would need a Solana verifier program |
| **Zero-knowledge property** | ❌ Not achieved | Verification currently requires VRF reveal |

### Path to Production

To make this production-ready:

1. Replace SHA-256 hash chains with a real STARK prover (e.g., [Winterfell](https://github.com/facebook/winterfell), [Cairo](https://www.cairo-lang.org/), or [SP1](https://github.com/succinctlabs/sp1))
2. The constraint circuit logic (Fisher-Yates derivation) stays the same — it just gets compiled into STARK constraints
3. Add an on-chain Solana program that verifies STARK proofs
4. Integrate with Switchboard VRF for production randomness

## Usage

### Generate a Proof

```typescript
import { generateProof } from '@agent-casino/sdk/vrf-proof';
import { randomBytes } from 'crypto';

// In production: vrfOutput comes from Switchboard VRF on Solana
const vrfOutput = randomBytes(32);

const result = generateProof(vrfOutput, {
  numPlayers: 6,
  cardsPerPlayer: 2,    // Texas Hold'em hole cards
  communityCards: 5,     // Flop + turn + river
  gameId: 'game-abc123',
});

// Cards dealt to each player
result.playerHands.forEach((hand, i) => {
  console.log(`Player ${i}: ${hand.map(c => `${c.rank}${c.suit[0]}`).join(', ')}`);
});

// Community cards
console.log(`Board: ${result.community.map(c => `${c.rank}${c.suit[0]}`).join(', ')}`);

// The attestation — safe to publish
console.log(JSON.stringify(result.attestation, null, 2));
```

### Verify a Proof

```typescript
import { verifyProof } from '@agent-casino/sdk/vrf-proof';

// Full verification (with VRF output — e.g., after game concludes)
const verification = verifyProof(
  attestation,           // Published attestation
  dealtCardIndices,      // The card indices that were dealt
  gameParams,            // Game configuration
  vrfOutput              // The revealed VRF output
);

console.log(verification.summary);
// → "FULLY VERIFIED: Cards are the correct deterministic derivation of the VRF output."

// Commitment-only verification (without VRF output)
const partialVerification = verifyProof(attestation, dealtCardIndices, gameParams);
console.log(partialVerification.summary);
// → "COMMITMENTS VALID: Card commitments match, but VRF output not provided..."
```

### Pre-Game Commitment Flow

```typescript
import { generatePreGameCommitment, generateProof } from '@agent-casino/sdk/vrf-proof';

// Step 1: Before game — publish commitment
const commitment = generatePreGameCommitment(vrfOutput, 'game-xyz');
// → Publish commitment.vrfCommitment on-chain or via API

// Step 2: Game plays — cards are dealt
const result = generateProof(vrfOutput, gameParams);

// Step 3: After game — publish full attestation
// Anyone can verify: commitment.vrfCommitment === result.attestation.vrfCommitment
```

## MoltLaunch Attestation Format

The proof output follows the MoltLaunch attestation standard:

```json
{
  "type": "vrf-constraint",
  "version": "0.1.0",
  "gameId": "game-abc123",
  "vrfCommitment": "a1b2c3...",
  "cardCommitment": "d4e5f6...",
  "proof": "789abc...",
  "verifiable": true,
  "timestamp": 1707609600000
}
```

This integrates with the existing `ExecutionAttestation` format in `sdk/src/attestation.ts`. The VRF constraint attestation can be published alongside game attestations to provide a complete provability chain:

1. **ExecutionAttestation** — proves the game transaction happened on-chain
2. **VrfConstraintAttestation** — proves the cards were fairly derived from VRF

Together, they form an end-to-end proof: random seed → card derivation → game outcome → on-chain settlement.

## API Reference

### Core Functions

| Function | Description |
|----------|-------------|
| `generateProof(vrfOutput, gameParams)` | Execute constraint circuit and generate proof |
| `verifyProof(attestation, cards, params, vrfOutput?)` | Verify a proof (full or commitment-only) |
| `generatePreGameCommitment(vrfOutput, gameId)` | Generate pre-game VRF commitment |
| `quickVerify(attestation, cards, gameId, vrfOutput)` | Simple boolean verification |

### Utility Functions

| Function | Description |
|----------|-------------|
| `indexToCard(index)` | Convert 0-51 index to Card object |
| `cardToIndex(suit, rank)` | Convert Card to 0-51 index |
| `serializeAttestation(attestation)` | Deterministic JSON serialization |
| `hashAttestation(attestation)` | SHA-256 hash for on-chain anchoring |
| `executeConstraint(vrfOutput, params)` | Raw constraint circuit execution |

### Types

| Type | Description |
|------|-------------|
| `GameParams` | Game configuration (players, cards, community, gameId) |
| `Card` | Card with index, suit, and rank |
| `VrfConstraintAttestation` | MoltLaunch-compatible attestation |
| `ProofResult` | Full proof result with cards and attestation |
| `VerificationResult` | Detailed verification result with check breakdown |

## Architecture

```
VRF Output (32 bytes)
    │
    ├── commitToVrf() ──────────── vrfCommitment (published pre-game)
    │
    ├── expandVrfOutput() ──────── hash chain expansion
    │       │
    │       └── deriveCards() ──── Fisher-Yates shuffle
    │               │
    │               └── Cards ──── commitToCards() ── cardCommitment
    │                                    │
    └────────────────────────────────────┴── proof (combined commitment)
```

## License

MIT — Part of the Agent Casino protocol.
