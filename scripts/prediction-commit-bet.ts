import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

/**
 * Generate commitment hash: hash(outcome_index || salt)
 * This hides your choice while locking in your bet
 */
function generateCommitment(outcomeIndex: number, salt: Buffer): Buffer {
  // Use same mixing function as on-chain
  const preimage = Buffer.alloc(33);
  preimage[0] = outcomeIndex;
  salt.copy(preimage, 1);

  // Simple deterministic hash (matches on-chain mix_bytes)
  const result = Buffer.alloc(32);
  for (let i = 0; i < preimage.length; i++) {
    const idx = i % 32;
    result[idx] = (result[idx] + preimage[i]) & 0xff;
    result[(idx + 1) % 32] = (result[(idx + 1) % 32] * ((result[idx] + 1) & 0xff)) & 0xff;
    result[(idx + 7) % 32] ^= (preimage[i] + i) & 0xff;
  }
  // Additional mixing rounds
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 32; i++) {
      result[i] = (result[i] + result[(i + round + 1) % 32]) & 0xff;
      const rotated = ((result[i] << 3) | (result[i] >> 5)) & 0xff;
      result[(i + 13) % 32] ^= rotated;
    }
  }
  return result;
}

async function main() {
  // Parse arguments
  const marketIdStr = process.argv[2];
  const outcomeIndex = parseInt(process.argv[3]);
  const amountSol = parseFloat(process.argv[4]);

  if (!marketIdStr || isNaN(outcomeIndex) || isNaN(amountSol)) {
    console.log("Usage: npx ts-node scripts/prediction-commit-bet.ts <MARKET_ID> <OUTCOME_INDEX> <AMOUNT_SOL>");
    console.log("Example: npx ts-node scripts/prediction-commit-bet.ts 7xK... 0 0.1");
    console.log("\n⚠️  IMPORTANT: Save your salt to reveal your bet later!");
    process.exit(1);
  }

  const marketPda = new PublicKey(marketIdStr);
  const amount = new anchor.BN(amountSol * LAMPORTS_PER_SOL);

  // Load wallet
  const walletPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const walletKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  console.log("Bettor:", walletKeypair.publicKey.toString());

  // Connect to devnet
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // Load IDL
  const idlPath = path.join(__dirname, "../target/idl/agent_casino.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider) as any;

  // Derive PDAs
  const [housePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("house")],
    PROGRAM_ID
  );

  const [betPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pred_bet"), marketPda.toBuffer(), walletKeypair.publicKey.toBuffer()],
    PROGRAM_ID
  );

  // Fetch market
  let market;
  try {
    market = await program.account.predictionMarket.fetch(marketPda);
  } catch (e) {
    console.error("Market not found:", marketIdStr);
    process.exit(1);
  }

  console.log("\n--- Market Details ---");
  console.log("Question:", market.question);
  console.log("Status:", Object.keys(market.status)[0]);
  console.log("Total Committed:", market.totalCommitted.toNumber() / LAMPORTS_PER_SOL, "SOL");

  if (Object.keys(market.status)[0] !== "committing") {
    console.error("\n❌ Market is not in commit phase");
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  if (now >= market.commitDeadline.toNumber()) {
    console.error("\n❌ Commit phase has ended");
    process.exit(1);
  }

  console.log("\nOutcomes:");
  for (let i = 0; i < market.outcomeCount; i++) {
    const name = Buffer.from(market.outcomeNames[i]).toString().replace(/\0/g, '');
    console.log(`  ${i}: ${name}`);
  }

  if (outcomeIndex >= market.outcomeCount) {
    console.error(`\n❌ Invalid outcome index. Must be 0-${market.outcomeCount - 1}`);
    process.exit(1);
  }

  // Generate random salt (SAVE THIS!)
  const salt = crypto.randomBytes(32);

  // Generate commitment
  const commitment = generateCommitment(outcomeIndex, salt);

  const outcomeName = Buffer.from(market.outcomeNames[outcomeIndex]).toString().replace(/\0/g, '');

  // Calculate early bird discount
  const commitDeadline = market.commitDeadline.toNumber();
  const createdAt = market.createdAt.toNumber();
  const commitDuration = commitDeadline - createdAt;
  const timeUntilDeadline = commitDeadline - now;
  const earlyBirdFactor = commitDuration > 0 ? Math.min(1, timeUntilDeadline / commitDuration) : 0;
  const earlyBirdDiscountPercent = (earlyBirdFactor * 100).toFixed(1);
  const effectiveFeePercent = ((1 - earlyBirdFactor) * 1).toFixed(3); // Assuming 1% base fee

  console.log("\n=== COMMITTING BET (HIDDEN) ===");
  console.log("Your choice:", outcomeIndex, "-", outcomeName);
  console.log("Amount:", amountSol, "SOL");
  console.log("Commitment:", commitment.toString('hex'));

  console.log("\n🐦 EARLY BIRD BONUS:");
  console.log(`  You're ${earlyBirdDiscountPercent}% early in the commit phase`);
  console.log(`  Fee discount: ${earlyBirdDiscountPercent}% off (${effectiveFeePercent}% effective fee vs 1% base)`);
  if (earlyBirdFactor > 0.9) {
    console.log("  🎉 Excellent timing! You'll pay almost no fees if you win!");
  } else if (earlyBirdFactor > 0.5) {
    console.log("  👍 Good timing! Significant fee discount.");
  } else {
    console.log("  💡 Tip: Earlier bets get bigger fee discounts.");
  }

  console.log("\n⚠️  CRITICAL: SAVE THIS INFORMATION TO REVEAL YOUR BET!");
  console.log("═".repeat(60));
  console.log("MARKET:", marketPda.toString());
  console.log("OUTCOME:", outcomeIndex);
  console.log("SALT:", salt.toString('hex'));
  console.log("═".repeat(60));
  console.log("Without the salt, you CANNOT reveal your bet and will FORFEIT your funds!");

  // Save to file for convenience
  const revealInfo = {
    market: marketPda.toString(),
    outcome: outcomeIndex,
    outcomeName,
    amount: amountSol,
    salt: salt.toString('hex'),
    commitment: commitment.toString('hex'),
    bettor: walletKeypair.publicKey.toString(),
    timestamp: new Date().toISOString(),
  };

  const revealFilePath = path.join(__dirname, `../reveal-${marketPda.toString().slice(0, 8)}-${walletKeypair.publicKey.toString().slice(0, 8)}.json`);
  fs.writeFileSync(revealFilePath, JSON.stringify(revealInfo, null, 2));
  console.log("\n📁 Reveal info saved to:", revealFilePath);

  try {
    const tx = await program.methods
      .commitPredictionBet(Array.from(commitment), amount)
      .accounts({
        house: housePda,
        market: marketPda,
        bet: betPda,
        bettor: walletKeypair.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("\n✅ Bet committed (hidden)!");
    console.log("Transaction:", tx);
    console.log("\nYour choice is now hidden on-chain. Remember to reveal after commit phase ends!");
    console.log("Commit deadline:", new Date(market.commitDeadline.toNumber() * 1000).toISOString());

  } catch (e: any) {
    console.error("\nError committing bet:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
