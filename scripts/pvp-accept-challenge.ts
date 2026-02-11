import { loadWallet, isAgentWalletConfigured } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  // Get challenge ID from command line
  const challengeId = process.argv[2];
  if (!challengeId) {
    console.log("Usage: npx ts-node scripts/pvp-accept-challenge.ts <CHALLENGE_ID>");
    console.log("\nTo get open challenges, run: npx ts-node scripts/pvp-list-challenges.ts");
    process.exit(1);
  }

  const challengePda = new PublicKey(challengeId);

  // Load wallet (acceptor)
  // Load wallet (AgentWallet aware)
  const { keypair: walletKeypair } = loadWallet();
  console.log("Acceptor:", walletKeypair.publicKey.toString());

  // Connect to devnet
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // Load IDL
  const idlPath = path.join(__dirname, "../target/idl/agent_casino.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider) as any;

  // Fetch challenge details
  let challenge;
  try {
    challenge = await program.account.challenge.fetch(challengePda);
  } catch (e) {
    console.error("Challenge not found:", challengeId);
    process.exit(1);
  }

  console.log("\n--- Challenge Details ---");
  console.log("Challenger:", challenge.challenger.toString());
  console.log("Amount:", challenge.amount.toNumber() / LAMPORTS_PER_SOL, "SOL");
  console.log("Challenger's choice:", challenge.choice === 0 ? "HEADS" : "TAILS");
  console.log("Your side:", challenge.choice === 0 ? "TAILS" : "HEADS");
  console.log("Status:", Object.keys(challenge.status)[0]);

  if (Object.keys(challenge.status)[0] !== "open") {
    console.error("\nChallenge is not open!");
    process.exit(1);
  }

  if (challenge.challenger.toString() === walletKeypair.publicKey.toString()) {
    console.error("\nCannot accept your own challenge!");
    process.exit(1);
  }

  // Derive PDAs
  const [housePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("house")],
    PROGRAM_ID
  );

  const [challengerStatsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), challenge.challenger.toBuffer()],
    PROGRAM_ID
  );

  const [acceptorStatsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), walletKeypair.publicKey.toBuffer()],
    PROGRAM_ID
  );

  const clientSeed = crypto.randomBytes(32);

  console.log("\n--- Accepting Challenge ---");
  console.log("Matching bet:", challenge.amount.toNumber() / LAMPORTS_PER_SOL, "SOL");

  const balanceBefore = await connection.getBalance(walletKeypair.publicKey);

  try {
    const tx = await program.methods
      .acceptChallenge()
      .accounts({
        house: housePda,
        challenge: challengePda,
        challenger: challenge.challenger,
        challengerStats: challengerStatsPda,
        acceptorStats: acceptorStatsPda,
        acceptor: walletKeypair.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("\nTransaction:", tx);

    // Wait and fetch result
    await new Promise(resolve => setTimeout(resolve, 2000));

    const completedChallenge = await program.account.challenge.fetch(challengePda);
    const winner = completedChallenge.winner;
    const youWon = winner.toString() === walletKeypair.publicKey.toString();

    console.log("\n=== RESULT ===");
    console.log("Flip result:", completedChallenge.result === 0 ? "HEADS" : "TAILS");
    console.log("Winner:", winner.toString());
    console.log(youWon ? "YOU WON!" : "You lost");

    const balanceAfter = await connection.getBalance(walletKeypair.publicKey);
    const netChange = (balanceAfter - balanceBefore) / LAMPORTS_PER_SOL;
    console.log("Net change:", netChange.toFixed(6), "SOL");

    // Total pot info
    const totalPot = challenge.amount.toNumber() * 2;
    const houseTake = totalPot * 0.01; // 1% house edge
    const winnerPayout = totalPot - houseTake;
    console.log("\nPot:", totalPot / LAMPORTS_PER_SOL, "SOL");
    console.log("House take (1%):", houseTake / LAMPORTS_PER_SOL, "SOL");
    console.log("Winner payout:", winnerPayout / LAMPORTS_PER_SOL, "SOL");

  } catch (e: any) {
    console.error("\nError accepting challenge:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
