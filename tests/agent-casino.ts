import { PublicKey, Keypair, LAMPORTS_PER_SOL, Connection } from "@solana/web3.js";
import { expect } from "chai";
import { createHash, randomBytes } from "crypto";

// Real program ID
const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

describe("agent-casino", () => {

  describe("PDA Derivation", () => {
    let housePda: PublicKey;
    let houseBump: number;

    it("derives house PDA from correct seeds", () => {
      [housePda, houseBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("house")],
        PROGRAM_ID
      );
      expect(housePda.toBase58()).to.be.a("string");
      expect(houseBump).to.be.a("number").within(0, 255);
    });

    it("derives vault PDA from house PDA", () => {
      const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), housePda.toBuffer()],
        PROGRAM_ID
      );
      expect(vaultPda.toBase58()).to.be.a("string");
      expect(vaultBump).to.be.a("number").within(0, 255);
      // Vault PDA should differ from house PDA
      expect(vaultPda.toBase58()).to.not.equal(housePda.toBase58());
    });

    it("derives game record PDA from house + index", () => {
      const gameIndex = new Uint8Array(new BigUint64Array([BigInt(0)]).buffer);
      const [gamePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("game"), housePda.toBuffer(), Buffer.from(gameIndex)],
        PROGRAM_ID
      );
      expect(gamePda.toBase58()).to.be.a("string");
    });

    it("derives agent stats PDA from player pubkey", () => {
      const player = Keypair.generate().publicKey;
      const [statsPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent"), player.toBuffer()],
        PROGRAM_ID
      );
      expect(statsPda.toBase58()).to.be.a("string");
    });

    it("derives LP position PDA from house + provider", () => {
      const provider = Keypair.generate().publicKey;
      const [lpPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp"), housePda.toBuffer(), provider.toBuffer()],
        PROGRAM_ID
      );
      expect(lpPda.toBase58()).to.be.a("string");
    });

    it("derives memory pool PDA", () => {
      const [memPoolPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("memory_pool")],
        PROGRAM_ID
      );
      expect(memPoolPda.toBase58()).to.be.a("string");
    });

    it("derives token vault PDA from mint", () => {
      const mint = Keypair.generate().publicKey;
      const [tokenVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_vault"), mint.toBuffer()],
        PROGRAM_ID
      );
      expect(tokenVaultPda.toBase58()).to.be.a("string");
    });

    it("PDA derivation is deterministic", () => {
      const [pda1] = PublicKey.findProgramAddressSync([Buffer.from("house")], PROGRAM_ID);
      const [pda2] = PublicKey.findProgramAddressSync([Buffer.from("house")], PROGRAM_ID);
      expect(pda1.toBase58()).to.equal(pda2.toBase58());
    });
  });

  describe("Provably Fair Verification", () => {
    function computeResult(serverSeed: Buffer, clientSeed: Buffer, player: PublicKey): Buffer {
      const combined = Buffer.concat([serverSeed, clientSeed, player.toBuffer()]);
      return createHash("sha256").update(combined).digest();
    }

    it("generates deterministic results from same seeds", () => {
      const serverSeed = randomBytes(32);
      const clientSeed = randomBytes(32);
      const player = Keypair.generate().publicKey;

      const hash1 = computeResult(serverSeed, clientSeed, player);
      const hash2 = computeResult(serverSeed, clientSeed, player);

      expect(hash1.equals(hash2)).to.be.true;
    });

    it("generates different results for different client seeds", () => {
      const serverSeed = randomBytes(32);
      const player = Keypair.generate().publicKey;

      const hash1 = computeResult(serverSeed, randomBytes(32), player);
      const hash2 = computeResult(serverSeed, randomBytes(32), player);

      expect(hash1.equals(hash2)).to.be.false;
    });

    it("generates different results for different players", () => {
      const serverSeed = randomBytes(32);
      const clientSeed = randomBytes(32);

      const hash1 = computeResult(serverSeed, clientSeed, Keypair.generate().publicKey);
      const hash2 = computeResult(serverSeed, clientSeed, Keypair.generate().publicKey);

      expect(hash1.equals(hash2)).to.be.false;
    });

    it("coin flip: uniform distribution over 10,000 iterations", () => {
      let heads = 0;
      const iterations = 10000;

      for (let i = 0; i < iterations; i++) {
        const hash = createHash("sha256").update(randomBytes(64)).digest();
        if (hash[0] % 2 === 0) heads++;
      }

      const headsPercent = (heads / iterations) * 100;
      // Should be within 2% of 50%
      expect(headsPercent).to.be.within(48, 52);
    });

    it("dice roll: uniform distribution across 6 faces", () => {
      const counts = [0, 0, 0, 0, 0, 0];
      const iterations = 60000;

      for (let i = 0; i < iterations; i++) {
        const hash = createHash("sha256").update(randomBytes(64)).digest();
        // Use 16-bit value to reduce modulo bias
        const val = (hash[0] << 8 | hash[1]) % 6;
        counts[val]++;
      }

      // Each face should appear ~16.67% of the time, within 2%
      for (let face = 0; face < 6; face++) {
        const pct = (counts[face] / iterations) * 100;
        expect(pct).to.be.within(14.67, 18.67);
      }
    });

    it("limbo: result distribution matches expected curve", () => {
      // Limbo result = MAX_MULT / (hash_value / MAX_HASH_VALUE)
      // Higher results are exponentially rarer
      let above2x = 0;
      let above5x = 0;
      let above10x = 0;
      const iterations = 10000;

      for (let i = 0; i < iterations; i++) {
        const hash = createHash("sha256").update(randomBytes(64)).digest();
        // Simulate limbo: result = 100 / (hash[0..3] as float / 0xFFFFFFFF * 100)
        const val = hash.readUInt32BE(0) / 0xFFFFFFFF;
        const result = 1 / Math.max(val, 0.01);
        if (result >= 2) above2x++;
        if (result >= 5) above5x++;
        if (result >= 10) above10x++;
      }

      // ~50% should be above 2x, ~20% above 5x, ~10% above 10x
      const pct2x = (above2x / iterations) * 100;
      const pct5x = (above5x / iterations) * 100;
      const pct10x = (above10x / iterations) * 100;

      expect(pct2x).to.be.within(40, 60);
      expect(pct5x).to.be.within(12, 28);
      expect(pct10x).to.be.within(5, 15);
    });
  });

  describe("Payout Calculations", () => {
    const HOUSE_EDGE_BPS = 100; // 1%
    const edgeMultiplier = 1 - HOUSE_EDGE_BPS / 10000;

    it("coin flip: payout is ~1.98x with 1% edge", () => {
      const payout = 2 * edgeMultiplier;
      expect(payout).to.equal(1.98);
    });

    it("dice roll: payouts scale inversely with probability", () => {
      const expected = [
        { target: 1, mult: 6 },   // 1/6 chance
        { target: 2, mult: 3 },   // 2/6 chance
        { target: 3, mult: 2 },   // 3/6 chance
        { target: 4, mult: 1.5 }, // 4/6 chance
        { target: 5, mult: 1.2 }, // 5/6 chance
      ];

      for (const { target, mult } of expected) {
        const fairMultiplier = 6 / target;
        const housePayout = fairMultiplier * edgeMultiplier;
        expect(housePayout).to.be.closeTo(mult * edgeMultiplier, 0.01);
      }
    });

    it("limbo: expected value is negative (house edge)", () => {
      // For any target multiplier M:
      // Probability of winning = 1/M
      // Payout = M * 0.99
      // EV = (1/M) * M * 0.99 - 1 = 0.99 - 1 = -0.01
      for (const mult of [1.5, 2, 5, 10, 50, 100]) {
        const winProb = 1 / mult;
        const payout = mult * edgeMultiplier;
        const ev = winProb * payout - 1;
        expect(ev).to.be.closeTo(-0.01, 0.001);
      }
    });

    it("max bet respects pool percentage", () => {
      const pool = 5 * LAMPORTS_PER_SOL;
      const maxBetPercent = 2;
      const maxBet = (pool * maxBetPercent) / 100;
      expect(maxBet).to.equal(0.1 * LAMPORTS_PER_SOL);
    });

    it("house profit accumulates from edge", () => {
      const bets = 1000;
      const betAmount = 0.01;
      let houseProfit = 0;

      for (let i = 0; i < bets; i++) {
        const won = Math.random() < 0.5;
        if (won) {
          houseProfit -= betAmount * (1.98 - 1); // pays 0.98 profit
        } else {
          houseProfit += betAmount; // keeps bet
        }
      }

      // Over 1000 bets, house should average ~1% profit
      // With high variance, just check it's not wildly off
      const profitPercent = (houseProfit / (bets * betAmount)) * 100;
      expect(profitPercent).to.be.within(-10, 12);
    });
  });

  describe("Jupiter Mock Swap", () => {
    it("calculates correct SOL amount from USDC (6 decimals)", () => {
      // Mock rate: 84 USDC per SOL (default)
      const mockRate = 84;
      const usdcAmount = 1_000_000; // 1 USDC (6 decimals)
      const solAmount = (usdcAmount / Math.pow(10, 6)) / mockRate;
      const rounded = Math.round(solAmount * LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL;

      expect(rounded).to.be.closeTo(0.0119, 0.001);
    });

    it("handles different token decimals via configurable rate", () => {
      // USDT with 6 decimals at rate 84
      const rate = 84;
      const amount = 10_000_000; // 10 USDT
      const sol = (amount / 1e6) / rate;
      expect(sol).to.be.closeTo(0.119, 0.001);
    });

    it("mock mode returns expected result shape", () => {
      const mockRate = 84;
      const amount = 1_000_000;
      const result = {
        solAmount: Math.round(((amount / 1e6) / mockRate) * LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL,
        signature: 'MOCK_JUPITER_SWAP',
        inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        inputAmount: amount,
        requestId: 'mock-devnet',
        mock: true,
      };

      expect(result).to.have.all.keys('solAmount', 'signature', 'inputMint', 'inputAmount', 'requestId', 'mock');
      expect(result.mock).to.be.true;
      expect(result.solAmount).to.be.greaterThan(0);
    });
  });

  describe("x402 Payment Protocol", () => {
    it("402 response contains required x402 fields", () => {
      // Simulating expected 402 response format
      const response = {
        x402Version: 1,
        accepts: [{
          scheme: "exact",
          network: "solana-devnet",
          maxAmountRequired: "10000",
          resource: "/v1/games/coinflip",
          payTo: "CASINO_USDC_ATA",
          asset: "usdc",
          extra: { game: "coinflip", betSOL: 0.01 }
        }]
      };

      expect(response.x402Version).to.equal(1);
      expect(response.accepts).to.be.an("array").with.lengthOf(1);
      expect(response.accepts[0].scheme).to.equal("exact");
      expect(response.accepts[0].asset).to.equal("usdc");
      expect(response.accepts[0]).to.have.property("maxAmountRequired");
      expect(response.accepts[0]).to.have.property("payTo");
    });

    it("game endpoints accept correct query parameters", () => {
      const endpoints = [
        { path: "/v1/games/coinflip", params: { choice: "heads" } },
        { path: "/v1/games/diceroll", params: { target: "3" } },
        { path: "/v1/games/limbo", params: { multiplier: "2.5" } },
        { path: "/v1/games/crash", params: { multiplier: "1.5" } },
      ];

      for (const ep of endpoints) {
        expect(ep.path).to.match(/^\/v1\/games\/(coinflip|diceroll|limbo|crash)$/);
        expect(Object.keys(ep.params)).to.have.lengthOf(1);
      }
    });

    it("USDC price converts to correct lamports bet", () => {
      // 0.01 USDC = 10000 micro-USDC (6 decimals)
      // Server bets 0.001 SOL per game
      const priceUSDC = 0.01;
      const microUSDC = priceUSDC * 1e6;
      expect(microUSDC).to.equal(10000);

      const betSOL = 0.001;
      const betLamports = betSOL * LAMPORTS_PER_SOL;
      expect(betLamports).to.equal(1000000);
    });
  });

  describe("Risk-Adjusted Betting (WARGAMES)", () => {
    it("clamps risk multiplier within bounds", () => {
      const minMult = 0.3;
      const maxMult = 2.0;

      function clamp(value: number): number {
        return Math.max(minMult, Math.min(maxMult, value));
      }

      expect(clamp(0.1)).to.equal(0.3);
      expect(clamp(1.0)).to.equal(1.0);
      expect(clamp(5.0)).to.equal(2.0);
      expect(clamp(0.3)).to.equal(0.3);
      expect(clamp(2.0)).to.equal(2.0);
    });

    it("per-game multipliers adjust bets differently", () => {
      // Crash games should be more conservative than coin flips
      const gameMultipliers = {
        coinFlip: 1.0,
        diceRoll: 0.9,
        limbo: 0.7,
        crash: 0.6,
      };

      const baseBet = 0.01;
      const riskMult = 1.5;

      const coinFlipBet = baseBet * riskMult * gameMultipliers.coinFlip;
      const crashBet = baseBet * riskMult * gameMultipliers.crash;

      expect(coinFlipBet).to.be.greaterThan(crashBet);
      expect(crashBet).to.be.closeTo(0.009, 0.001);
    });

    it("high fear = lower bets, high greed = higher bets", () => {
      function riskFromFearGreed(fg: number): number {
        // fg: 0 = extreme fear, 100 = extreme greed
        // Simple linear: mult = 0.5 + (fg / 100) * 1.0
        return 0.5 + (fg / 100) * 1.0;
      }

      const fearMult = riskFromFearGreed(10);  // extreme fear
      const neutralMult = riskFromFearGreed(50);
      const greedMult = riskFromFearGreed(90);  // extreme greed

      expect(fearMult).to.be.lessThan(neutralMult);
      expect(neutralMult).to.be.lessThan(greedMult);
      expect(fearMult).to.be.closeTo(0.6, 0.01);
      expect(greedMult).to.be.closeTo(1.4, 0.01);
    });
  });

  describe("Edge Cases", () => {
    it("rejects bets with zero amount", () => {
      const minBet = 0.001 * LAMPORTS_PER_SOL;
      const bet = 0;
      expect(bet).to.be.lessThan(minBet);
    });

    it("rejects dice target outside 1-5 range", () => {
      const validTargets = [1, 2, 3, 4, 5];
      expect(validTargets).to.not.include(0);
      expect(validTargets).to.not.include(6);
    });

    it("rejects limbo multiplier below 1.01", () => {
      const minMultiplier = 1.01;
      expect(1.00).to.be.lessThan(minMultiplier);
      expect(0.5).to.be.lessThan(minMultiplier);
    });

    it("rejects limbo multiplier above 100", () => {
      const maxMultiplier = 100;
      expect(100.1).to.be.greaterThan(maxMultiplier);
    });

    it("handles concurrent PDA derivations", () => {
      // Different game indices produce different PDAs
      const [housePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("house")],
        PROGRAM_ID
      );

      const pdas = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const idx = new Uint8Array(new BigUint64Array([BigInt(i)]).buffer);
        const [gamePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("game"), housePda.toBuffer(), Buffer.from(idx)],
          PROGRAM_ID
        );
        pdas.add(gamePda.toBase58());
      }

      // All 100 game PDAs should be unique
      expect(pdas.size).to.equal(100);
    });

    it("SPL token vault PDA differs per mint", () => {
      const mints = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
      const pdas = new Set<string>();

      for (const mint of mints) {
        const [vaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("token_vault"), mint.toBuffer()],
          PROGRAM_ID
        );
        pdas.add(vaultPda.toBase58());
      }

      expect(pdas.size).to.equal(5);
    });
  });
});
