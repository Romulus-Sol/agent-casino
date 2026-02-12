/**
 * VRF Constraint Proof — Tests
 *
 * Verifies the constraint circuit, proof generation, and verification flow.
 * Run with: npx ts-mocha tests/vrf-proof.test.ts
 */

import { expect } from 'chai';
import { randomBytes, createHash } from 'crypto';
import {
  // Constraint circuit
  indexToCard,
  cardToIndex,
  executeConstraint,
  expandVrfOutput,
  deriveCards,
  commitToVrf,
  commitToCards,
  generateConstraintCommitment,
  verifyDerivation,
  verifyConstraintCommitment,
  // Proof
  generateProof,
  generatePreGameCommitment,
  verifyProof,
  quickVerify,
  serializeAttestation,
  hashAttestation,
  deserializeAttestation,
  // Types
  GameParams,
  Card,
} from '../sdk/src/vrf-proof';

describe('VRF Constraint Circuit', () => {
  // Fixed VRF output for deterministic tests
  const fixedVrf = Buffer.from(
    'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
    'hex'
  );

  const texasHoldemParams: GameParams = {
    numPlayers: 6,
    cardsPerPlayer: 2,
    communityCards: 5,
    gameId: 'test-game-001',
  };

  describe('Card Utilities', () => {
    it('should convert index to card correctly', () => {
      const aceOfSpades = indexToCard(51);
      expect(aceOfSpades.suit).to.equal('spades');
      expect(aceOfSpades.rank).to.equal('A');

      const twoOfHearts = indexToCard(0);
      expect(twoOfHearts.suit).to.equal('hearts');
      expect(twoOfHearts.rank).to.equal('2');

      const kingOfDiamonds = indexToCard(24);
      expect(kingOfDiamonds.suit).to.equal('diamonds');
      expect(kingOfDiamonds.rank).to.equal('K');
    });

    it('should round-trip card index conversions', () => {
      for (let i = 0; i < 52; i++) {
        const card = indexToCard(i);
        const backToIndex = cardToIndex(card.suit, card.rank);
        expect(backToIndex).to.equal(i);
      }
    });

    it('should reject invalid card indices', () => {
      expect(() => indexToCard(-1)).to.throw('Invalid card index');
      expect(() => indexToCard(52)).to.throw('Invalid card index');
    });

    it('should reject invalid card names', () => {
      expect(() => cardToIndex('bananas', 'A')).to.throw('Invalid card');
      expect(() => cardToIndex('hearts', 'Z')).to.throw('Invalid card');
    });
  });

  describe('VRF Expansion', () => {
    it('should expand VRF output to required length', () => {
      const { expanded, hashChain } = expandVrfOutput(fixedVrf, 100);
      expect(expanded.length).to.equal(100);
      expect(hashChain.length).to.be.greaterThan(0);
    });

    it('should be deterministic', () => {
      const { expanded: a } = expandVrfOutput(fixedVrf, 64);
      const { expanded: b } = expandVrfOutput(fixedVrf, 64);
      expect(a.equals(b)).to.be.true;
    });

    it('should produce different output for different VRF inputs', () => {
      const vrf2 = Buffer.from(
        'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3',
        'hex'
      );
      const { expanded: a } = expandVrfOutput(fixedVrf, 64);
      const { expanded: b } = expandVrfOutput(vrf2, 64);
      expect(a.equals(b)).to.be.false;
    });
  });

  describe('Card Derivation', () => {
    it('should derive the correct number of cards', () => {
      const { indices } = deriveCards(fixedVrf, 17); // 6*2 + 5
      expect(indices.length).to.equal(17);
    });

    it('should produce no duplicate cards', () => {
      const { indices } = deriveCards(fixedVrf, 17);
      const uniqueCards = new Set(indices);
      expect(uniqueCards.size).to.equal(indices.length);
    });

    it('should produce valid card indices (0-51)', () => {
      const { indices } = deriveCards(fixedVrf, 17);
      for (const idx of indices) {
        expect(idx).to.be.at.least(0);
        expect(idx).to.be.below(52);
      }
    });

    it('should be deterministic for same VRF output', () => {
      const { indices: a } = deriveCards(fixedVrf, 17);
      const { indices: b } = deriveCards(fixedVrf, 17);
      expect(a).to.deep.equal(b);
    });

    it('should produce different cards for different VRF outputs', () => {
      const vrf2 = randomBytes(32);
      const { indices: a } = deriveCards(fixedVrf, 17);
      const { indices: b } = deriveCards(vrf2, 17);
      // Extremely unlikely to be identical with different random inputs
      expect(a).to.not.deep.equal(b);
    });

    it('should reject requests for more than 52 cards', () => {
      expect(() => deriveCards(fixedVrf, 53)).to.throw('Cannot deal 53 cards');
    });

    it('should handle maximum deck deal (52 cards)', () => {
      const { indices } = deriveCards(fixedVrf, 52);
      expect(indices.length).to.equal(52);
      const uniqueCards = new Set(indices);
      expect(uniqueCards.size).to.equal(52);
    });
  });

  describe('Constraint Execution', () => {
    it('should execute a Texas Hold\'em deal', () => {
      const witness = executeConstraint(fixedVrf, texasHoldemParams);

      expect(witness.deal.playerHands.length).to.equal(6);
      for (const hand of witness.deal.playerHands) {
        expect(hand.length).to.equal(2);
      }
      expect(witness.deal.community.length).to.equal(5);
      expect(witness.deal.allDealtIndices.length).to.equal(17);
    });

    it('should produce valid cards in all hands', () => {
      const witness = executeConstraint(fixedVrf, texasHoldemParams);

      const allCards = [
        ...witness.deal.playerHands.flat(),
        ...witness.deal.community,
      ];

      for (const card of allCards) {
        expect(card.index).to.be.at.least(0);
        expect(card.index).to.be.below(52);
        expect(['hearts', 'diamonds', 'clubs', 'spades']).to.include(card.suit);
      }
    });

    it('should reject invalid game parameters', () => {
      expect(() =>
        executeConstraint(fixedVrf, { ...texasHoldemParams, numPlayers: 0 })
      ).to.throw('numPlayers must be 1-10');

      expect(() =>
        executeConstraint(fixedVrf, { ...texasHoldemParams, numPlayers: 11 })
      ).to.throw('numPlayers must be 1-10');

      expect(() =>
        executeConstraint(fixedVrf, { ...texasHoldemParams, cardsPerPlayer: 0 })
      ).to.throw('cardsPerPlayer must be 1-7');
    });

    it('should reject deals that exceed deck size', () => {
      expect(() =>
        executeConstraint(fixedVrf, {
          numPlayers: 10,
          cardsPerPlayer: 7,
          communityCards: 0,
          gameId: 'test',
        })
      ).to.throw('exceeds deck size');
    });
  });

  describe('Commitments', () => {
    it('should generate deterministic VRF commitment', () => {
      const c1 = commitToVrf(fixedVrf);
      const c2 = commitToVrf(fixedVrf);
      expect(c1).to.equal(c2);
      expect(c1).to.have.length(64); // SHA-256 hex
    });

    it('should generate different commitments for different VRF outputs', () => {
      const c1 = commitToVrf(fixedVrf);
      const c2 = commitToVrf(randomBytes(32));
      expect(c1).to.not.equal(c2);
    });

    it('should generate deterministic card commitment', () => {
      const cards = [0, 1, 2, 3, 4];
      const c1 = commitToCards(cards, 'game-1');
      const c2 = commitToCards(cards, 'game-1');
      expect(c1).to.equal(c2);
    });

    it('should produce different card commitments for different game IDs', () => {
      const cards = [0, 1, 2, 3, 4];
      const c1 = commitToCards(cards, 'game-1');
      const c2 = commitToCards(cards, 'game-2');
      expect(c1).to.not.equal(c2);
    });

    it('should produce different card commitments for different cards', () => {
      const c1 = commitToCards([0, 1, 2], 'game-1');
      const c2 = commitToCards([3, 4, 5], 'game-1');
      expect(c1).to.not.equal(c2);
    });

    it('should generate valid constraint commitment', () => {
      const cards = [0, 1, 2, 3, 4];
      const commitment = generateConstraintCommitment(fixedVrf, cards, 'game-1');
      expect(commitment).to.have.length(64);
    });
  });

  describe('Verification', () => {
    it('should verify correct card derivation', () => {
      const witness = executeConstraint(fixedVrf, texasHoldemParams);
      const valid = verifyDerivation(fixedVrf, texasHoldemParams, witness.deal.allDealtIndices);
      expect(valid).to.be.true;
    });

    it('should reject incorrect cards', () => {
      const witness = executeConstraint(fixedVrf, texasHoldemParams);
      const tamperedCards = [...witness.deal.allDealtIndices];
      tamperedCards[0] = (tamperedCards[0] + 1) % 52; // Tamper with first card
      const valid = verifyDerivation(fixedVrf, texasHoldemParams, tamperedCards);
      expect(valid).to.be.false;
    });

    it('should reject wrong number of cards', () => {
      const witness = executeConstraint(fixedVrf, texasHoldemParams);
      const fewerCards = witness.deal.allDealtIndices.slice(0, -1);
      const valid = verifyDerivation(fixedVrf, texasHoldemParams, fewerCards);
      expect(valid).to.be.false;
    });

    it('should verify constraint commitment', () => {
      const witness = executeConstraint(fixedVrf, texasHoldemParams);
      const commitment = generateConstraintCommitment(
        fixedVrf,
        witness.deal.allDealtIndices,
        texasHoldemParams.gameId
      );

      const valid = verifyConstraintCommitment(
        fixedVrf,
        witness.deal.allDealtIndices,
        texasHoldemParams.gameId,
        commitment
      );
      expect(valid).to.be.true;
    });

    it('should reject tampered constraint commitment', () => {
      const witness = executeConstraint(fixedVrf, texasHoldemParams);
      const commitment = generateConstraintCommitment(
        fixedVrf,
        witness.deal.allDealtIndices,
        texasHoldemParams.gameId
      );

      // Try with different VRF output
      const valid = verifyConstraintCommitment(
        randomBytes(32),
        witness.deal.allDealtIndices,
        texasHoldemParams.gameId,
        commitment
      );
      expect(valid).to.be.false;
    });
  });
});

describe('VRF Constraint Proof', () => {
  const vrfOutput = randomBytes(32);
  const gameParams: GameParams = {
    numPlayers: 4,
    cardsPerPlayer: 2,
    communityCards: 5,
    gameId: 'proof-test-001',
  };

  describe('Proof Generation', () => {
    it('should generate a valid proof', () => {
      const result = generateProof(vrfOutput, gameParams);

      expect(result.attestation.type).to.equal('vrf-constraint');
      expect(result.attestation.version).to.equal('0.1.0');
      expect(result.attestation.gameId).to.equal('proof-test-001');
      expect(result.attestation.vrfCommitment).to.have.length(64);
      expect(result.attestation.cardCommitment).to.have.length(64);
      expect(result.attestation.proof).to.have.length(64);
      expect(result.attestation.verifiable).to.be.true;
      expect(result.attestation.timestamp).to.be.a('number');
    });

    it('should deal correct number of cards', () => {
      const result = generateProof(vrfOutput, gameParams);

      expect(result.playerHands.length).to.equal(4);
      expect(result.community.length).to.equal(5);
      expect(result.allDealtIndices.length).to.equal(13);
      expect(result.cards.length).to.equal(13);
    });

    it('should be deterministic', () => {
      const r1 = generateProof(vrfOutput, gameParams);
      const r2 = generateProof(vrfOutput, gameParams);

      expect(r1.allDealtIndices).to.deep.equal(r2.allDealtIndices);
      expect(r1.attestation.vrfCommitment).to.equal(r2.attestation.vrfCommitment);
      expect(r1.attestation.cardCommitment).to.equal(r2.attestation.cardCommitment);
      expect(r1.attestation.proof).to.equal(r2.attestation.proof);
    });

    it('should reject invalid VRF output', () => {
      expect(() => generateProof(Buffer.alloc(16), gameParams)).to.throw(
        'VRF output must be a Buffer of at least 32 bytes'
      );
    });

    it('should include witness with private data', () => {
      const result = generateProof(vrfOutput, gameParams);

      expect(result.witness.vrfOutput.equals(vrfOutput)).to.be.true;
      expect(result.witness.hashChain.length).to.be.greaterThan(0);
    });
  });

  describe('Proof Verification', () => {
    it('should fully verify a valid proof', () => {
      const result = generateProof(vrfOutput, gameParams);

      const verification = verifyProof(
        result.attestation,
        result.allDealtIndices,
        gameParams,
        vrfOutput
      );

      expect(verification.valid).to.be.true;
      expect(verification.checks.vrfCommitmentValid).to.be.true;
      expect(verification.checks.cardCommitmentValid).to.be.true;
      expect(verification.checks.proofValid).to.be.true;
      expect(verification.checks.derivationValid).to.be.true;
      expect(verification.summary).to.include('FULLY VERIFIED');
    });

    it('should partially verify without VRF output', () => {
      const result = generateProof(vrfOutput, gameParams);

      const verification = verifyProof(
        result.attestation,
        result.allDealtIndices,
        gameParams
        // No VRF output — commitment-only verification
      );

      expect(verification.valid).to.be.true;
      expect(verification.checks.cardCommitmentValid).to.be.true;
      expect(verification.checks.derivationValid).to.be.null;
      expect(verification.summary).to.include('COMMITMENTS VALID');
    });

    it('should fail with tampered cards', () => {
      const result = generateProof(vrfOutput, gameParams);
      const tamperedCards = [...result.allDealtIndices];
      tamperedCards[0] = (tamperedCards[0] + 1) % 52;

      const verification = verifyProof(
        result.attestation,
        tamperedCards,
        gameParams,
        vrfOutput
      );

      expect(verification.valid).to.be.false;
      expect(verification.checks.cardCommitmentValid).to.be.false;
      expect(verification.summary).to.include('VERIFICATION FAILED');
    });

    it('should fail with wrong VRF output', () => {
      const result = generateProof(vrfOutput, gameParams);
      const wrongVrf = randomBytes(32);

      const verification = verifyProof(
        result.attestation,
        result.allDealtIndices,
        gameParams,
        wrongVrf
      );

      expect(verification.valid).to.be.false;
      expect(verification.checks.vrfCommitmentValid).to.be.false;
      expect(verification.summary).to.include('VERIFICATION FAILED');
    });

    it('should fail with wrong game ID', () => {
      const result = generateProof(vrfOutput, gameParams);
      const wrongParams = { ...gameParams, gameId: 'wrong-game-id' };

      const verification = verifyProof(
        result.attestation,
        result.allDealtIndices,
        wrongParams,
        vrfOutput
      );

      expect(verification.valid).to.be.false;
      expect(verification.checks.cardCommitmentValid).to.be.false;
    });
  });

  describe('Quick Verify', () => {
    it('should return true for valid proof', () => {
      const result = generateProof(vrfOutput, gameParams);
      const valid = quickVerify(
        result.attestation,
        result.allDealtIndices,
        gameParams.gameId,
        vrfOutput
      );
      expect(valid).to.be.true;
    });

    it('should return false for tampered proof', () => {
      const result = generateProof(vrfOutput, gameParams);
      const valid = quickVerify(
        result.attestation,
        result.allDealtIndices,
        gameParams.gameId,
        randomBytes(32)
      );
      expect(valid).to.be.false;
    });
  });

  describe('Pre-Game Commitment', () => {
    it('should generate matching pre-game commitment', () => {
      const preGame = generatePreGameCommitment(vrfOutput, gameParams.gameId);
      const result = generateProof(vrfOutput, gameParams);

      expect(preGame.vrfCommitment).to.equal(result.attestation.vrfCommitment);
      expect(preGame.gameId).to.equal(gameParams.gameId);
    });
  });

  describe('Serialization', () => {
    it('should serialize and deserialize attestation', () => {
      const result = generateProof(vrfOutput, gameParams);
      const json = serializeAttestation(result.attestation);
      const parsed = deserializeAttestation(json);

      expect(parsed.type).to.equal('vrf-constraint');
      expect(parsed.gameId).to.equal(result.attestation.gameId);
      expect(parsed.vrfCommitment).to.equal(result.attestation.vrfCommitment);
      expect(parsed.proof).to.equal(result.attestation.proof);
    });

    it('should produce deterministic attestation hash', () => {
      const result = generateProof(vrfOutput, gameParams);
      const h1 = hashAttestation(result.attestation);
      const h2 = hashAttestation(result.attestation);
      expect(h1).to.equal(h2);
      expect(h1).to.have.length(64);
    });

    it('should reject invalid attestation JSON', () => {
      expect(() => deserializeAttestation('{"type":"wrong"}')).to.throw('Invalid attestation type');
      expect(() => deserializeAttestation('{"type":"vrf-constraint"}')).to.throw('missing required fields');
    });
  });

  describe('End-to-End Flow', () => {
    it('should work for a complete game lifecycle', () => {
      // === Pre-game: House generates VRF and publishes commitment ===
      const houseVrf = randomBytes(32);
      const preGame = generatePreGameCommitment(houseVrf, 'e2e-game');
      // preGame.vrfCommitment would be published on-chain

      // === Game: Cards are dealt ===
      const gameParams: GameParams = {
        numPlayers: 2,
        cardsPerPlayer: 2,
        communityCards: 5,
        gameId: 'e2e-game',
      };
      const proof = generateProof(houseVrf, gameParams);

      // Verify pre-game commitment matches
      expect(proof.attestation.vrfCommitment).to.equal(preGame.vrfCommitment);

      // === Post-game: Publish proof and reveal VRF ===
      const attestationJson = serializeAttestation(proof.attestation);

      // === Verification: Any participant verifies ===
      const parsedAttestation = deserializeAttestation(attestationJson);
      const verification = verifyProof(
        parsedAttestation,
        proof.allDealtIndices,
        gameParams,
        houseVrf
      );

      expect(verification.valid).to.be.true;
      expect(verification.checks.derivationValid).to.be.true;
      expect(verification.summary).to.include('FULLY VERIFIED');

      // Verify the attestation hash
      const onChainHash = hashAttestation(proof.attestation);
      const recomputedHash = hashAttestation(parsedAttestation);
      expect(onChainHash).to.equal(recomputedHash);
    });

    it('should detect cheating (house tries to swap cards)', () => {
      const houseVrf = randomBytes(32);
      const gameParams: GameParams = {
        numPlayers: 2,
        cardsPerPlayer: 2,
        communityCards: 5,
        gameId: 'cheat-detection-game',
      };

      // House generates honest proof
      const honestProof = generateProof(houseVrf, gameParams);

      // House tries to swap first card to give player 1 a better hand
      const tamperedCards = [...honestProof.allDealtIndices];
      tamperedCards[0] = 51; // Force Ace of Spades

      // Verification catches the tampering
      const verification = verifyProof(
        honestProof.attestation,
        tamperedCards,
        gameParams,
        houseVrf
      );

      expect(verification.valid).to.be.false;
      expect(verification.checks.cardCommitmentValid).to.be.false;
      expect(verification.summary).to.include('VERIFICATION FAILED');
    });

    it('should handle heads-up poker (2 players)', () => {
      const vrf = randomBytes(32);
      const params: GameParams = {
        numPlayers: 2,
        cardsPerPlayer: 2,
        communityCards: 5,
        gameId: 'heads-up-001',
      };

      const result = generateProof(vrf, params);
      expect(result.playerHands.length).to.equal(2);
      expect(result.community.length).to.equal(5);
      expect(result.allDealtIndices.length).to.equal(9);

      const verification = verifyProof(result.attestation, result.allDealtIndices, params, vrf);
      expect(verification.valid).to.be.true;
    });

    it('should handle max players (10-player Omaha)', () => {
      const vrf = randomBytes(32);
      const params: GameParams = {
        numPlayers: 10,
        cardsPerPlayer: 4, // Omaha
        communityCards: 5,
        gameId: 'max-omaha-001',
      };

      const result = generateProof(vrf, params);
      expect(result.playerHands.length).to.equal(10);
      expect(result.allDealtIndices.length).to.equal(45);

      // Verify no duplicates
      const unique = new Set(result.allDealtIndices);
      expect(unique.size).to.equal(45);

      const verification = verifyProof(result.attestation, result.allDealtIndices, params, vrf);
      expect(verification.valid).to.be.true;
    });
  });
});
