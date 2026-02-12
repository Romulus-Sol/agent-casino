/**
 * VRF Constraint Circuit — Proof of Concept
 *
 * Proves that card deals are deterministically derived from VRF output.
 * This is a simplified constraint circuit that uses SHA-256 for commitments
 * rather than a full ZK/STARK prover — suitable for demonstrating the
 * architecture and integration pattern.
 *
 * The constraint enforces:
 *   1. Cards are derived from VRF output via deterministic modular arithmetic
 *   2. No card is dealt twice within a round (Fisher-Yates on VRF bytes)
 *   3. The derivation can be verified against a commitment without revealing the VRF seed
 *
 * In production, this would be replaced with a real STARK circuit (e.g., Cairo/Winterfell)
 * that generates succinct proofs verifiable on-chain.
 */

import { createHash } from 'crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GameParams {
  /** Number of players at the table */
  numPlayers: number;
  /** Number of cards dealt to each player (e.g., 2 for Texas Hold'em hole cards) */
  cardsPerPlayer: number;
  /** Number of community cards (e.g., 5 for Texas Hold'em) */
  communityCards: number;
  /** Game identifier — ties the proof to a specific game session */
  gameId: string;
}

export interface Card {
  /** 0-51 representing a standard deck */
  index: number;
  /** Human-readable suit: 'hearts' | 'diamonds' | 'clubs' | 'spades' */
  suit: string;
  /** Human-readable rank: '2'-'10', 'J', 'Q', 'K', 'A' */
  rank: string;
}

export interface DealResult {
  /** Cards dealt to each player, indexed by player number (0-based) */
  playerHands: Card[][];
  /** Community cards (flop, turn, river) */
  community: Card[];
  /** All dealt card indices in order */
  allDealtIndices: number[];
}

export interface ConstraintWitness {
  /** The raw VRF output bytes (private — never revealed in proof) */
  vrfOutput: Buffer;
  /** Game parameters */
  gameParams: GameParams;
  /** The derived deal */
  deal: DealResult;
  /** Intermediate hash chain values (for constraint verification) */
  hashChain: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DECK_SIZE = 52;
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// ─── Card Utilities ───────────────────────────────────────────────────────────

/**
 * Convert a card index (0-51) to a human-readable card.
 */
export function indexToCard(index: number): Card {
  if (index < 0 || index >= DECK_SIZE) {
    throw new Error(`Invalid card index: ${index}. Must be 0-51.`);
  }
  const suit = SUITS[Math.floor(index / 13)];
  const rank = RANKS[index % 13];
  return { index, suit, rank };
}

/**
 * Convert a human-readable card back to its index.
 */
export function cardToIndex(suit: string, rank: string): number {
  const suitIdx = SUITS.indexOf(suit);
  const rankIdx = RANKS.indexOf(rank);
  if (suitIdx === -1 || rankIdx === -1) {
    throw new Error(`Invalid card: ${rank} of ${suit}`);
  }
  return suitIdx * 13 + rankIdx;
}

// ─── Deterministic Derivation ─────────────────────────────────────────────────

/**
 * Expand VRF output into enough random bytes for dealing.
 * Uses a hash chain: H(vrf || counter) for each additional block needed.
 * This is the core of the constraint — it must be perfectly reproducible.
 */
export function expandVrfOutput(vrfOutput: Buffer, bytesNeeded: number): { expanded: Buffer; hashChain: string[] } {
  const blocks: Buffer[] = [];
  const hashChain: string[] = [];
  let totalBytes = 0;
  let counter = 0;

  while (totalBytes < bytesNeeded) {
    const input = Buffer.concat([
      vrfOutput,
      Buffer.from([counter >> 24, counter >> 16, counter >> 8, counter & 0xff]),
    ]);
    const hash = createHash('sha256').update(input).digest();
    blocks.push(hash);
    hashChain.push(hash.toString('hex'));
    totalBytes += hash.length;
    counter++;
  }

  return {
    expanded: Buffer.concat(blocks).subarray(0, bytesNeeded),
    hashChain,
  };
}

/**
 * Deterministically derive card selections from expanded VRF bytes.
 * Uses Fisher-Yates shuffle seeded by VRF output — guarantees no duplicates.
 *
 * This is the constraint that the proof verifies:
 *   Given VRF output V and game params G, the dealt cards C are the ONLY
 *   valid output of this function.
 */
export function deriveCards(vrfOutput: Buffer, totalCardsNeeded: number): { indices: number[]; hashChain: string[] } {
  if (totalCardsNeeded > DECK_SIZE) {
    throw new Error(`Cannot deal ${totalCardsNeeded} cards from a ${DECK_SIZE}-card deck`);
  }

  // We need 2 bytes per card selection for sufficient randomness
  const bytesNeeded = totalCardsNeeded * 2;
  const { expanded, hashChain } = expandVrfOutput(vrfOutput, bytesNeeded);

  // Initialize deck
  const deck = Array.from({ length: DECK_SIZE }, (_, i) => i);

  // Fisher-Yates shuffle using VRF-derived randomness
  const indices: number[] = [];
  for (let i = 0; i < totalCardsNeeded; i++) {
    const remainingCards = DECK_SIZE - i;
    // Read 2 bytes for this selection to get reasonable uniformity
    const randomValue = expanded.readUInt16BE(i * 2);
    const selectedIdx = i + (randomValue % remainingCards);

    // Swap
    [deck[i], deck[selectedIdx]] = [deck[selectedIdx], deck[i]];
    indices.push(deck[i]);
  }

  return { indices, hashChain };
}

/**
 * Execute the full constraint circuit: derive a complete deal from VRF output.
 */
export function executeConstraint(vrfOutput: Buffer, gameParams: GameParams): ConstraintWitness {
  // Validate params
  if (gameParams.numPlayers < 1 || gameParams.numPlayers > 10) {
    throw new Error('numPlayers must be 1-10');
  }
  if (gameParams.cardsPerPlayer < 1 || gameParams.cardsPerPlayer > 7) {
    throw new Error('cardsPerPlayer must be 1-7');
  }
  if (gameParams.communityCards < 0 || gameParams.communityCards > 5) {
    throw new Error('communityCards must be 0-5');
  }

  const totalCards = gameParams.numPlayers * gameParams.cardsPerPlayer + gameParams.communityCards;
  if (totalCards > DECK_SIZE) {
    throw new Error(`Total cards needed (${totalCards}) exceeds deck size (${DECK_SIZE})`);
  }

  const { indices, hashChain } = deriveCards(vrfOutput, totalCards);

  // Distribute cards
  const playerHands: Card[][] = [];
  let cardIdx = 0;

  for (let p = 0; p < gameParams.numPlayers; p++) {
    const hand: Card[] = [];
    for (let c = 0; c < gameParams.cardsPerPlayer; c++) {
      hand.push(indexToCard(indices[cardIdx++]));
    }
    playerHands.push(hand);
  }

  const community: Card[] = [];
  for (let c = 0; c < gameParams.communityCards; c++) {
    community.push(indexToCard(indices[cardIdx++]));
  }

  const deal: DealResult = {
    playerHands,
    community,
    allDealtIndices: indices,
  };

  return {
    vrfOutput,
    gameParams,
    deal,
    hashChain,
  };
}

// ─── Commitment Generation ────────────────────────────────────────────────────

/**
 * Generate a commitment to the VRF output without revealing it.
 * This is published before the game — it locks the house into a specific
 * random seed. After the game, the proof reveals the cards and proves
 * they were derived from this commitment.
 */
export function commitToVrf(vrfOutput: Buffer): string {
  return createHash('sha256').update(vrfOutput).digest('hex');
}

/**
 * Generate a commitment to the dealt cards.
 * Includes the game ID to prevent replay attacks.
 */
export function commitToCards(cards: number[], gameId: string): string {
  const data = Buffer.concat([
    Buffer.from(gameId, 'utf8'),
    Buffer.from(cards),
  ]);
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Generate the combined constraint commitment.
 * This binds: VRF output → card derivation → game ID
 * Anyone with the VRF output can verify this independently.
 */
export function generateConstraintCommitment(
  vrfOutput: Buffer,
  cards: number[],
  gameId: string
): string {
  const vrfCommitment = commitToVrf(vrfOutput);
  const cardCommitment = commitToCards(cards, gameId);

  // Bind both commitments together
  const combined = createHash('sha256')
    .update(Buffer.from(vrfCommitment, 'hex'))
    .update(Buffer.from(cardCommitment, 'hex'))
    .digest('hex');

  return combined;
}

// ─── Verification ─────────────────────────────────────────────────────────────

/**
 * Verify that a set of cards was correctly derived from a VRF output.
 * This is the verifier side of the constraint circuit.
 *
 * @param vrfOutput - The revealed VRF output (after game concludes)
 * @param gameParams - The game parameters
 * @param claimedCards - The cards that were claimed to be dealt
 * @returns true if the cards are the correct deterministic derivation
 */
export function verifyDerivation(
  vrfOutput: Buffer,
  gameParams: GameParams,
  claimedCards: number[]
): boolean {
  try {
    const witness = executeConstraint(vrfOutput, gameParams);
    const expectedCards = witness.deal.allDealtIndices;

    if (expectedCards.length !== claimedCards.length) return false;

    for (let i = 0; i < expectedCards.length; i++) {
      if (expectedCards[i] !== claimedCards[i]) return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Verify a constraint commitment against revealed data.
 * Used post-game: the house reveals the VRF output, and anyone can verify
 * that the commitment matches and the cards were fairly derived.
 */
export function verifyConstraintCommitment(
  vrfOutput: Buffer,
  cards: number[],
  gameId: string,
  expectedCommitment: string
): boolean {
  const actualCommitment = generateConstraintCommitment(vrfOutput, cards, gameId);
  return actualCommitment === expectedCommitment;
}
