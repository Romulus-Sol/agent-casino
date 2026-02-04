import { loadWallet, isAgentWalletConfigured } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  // Load main wallet (funder) - AgentWallet aware
  const { keypair: funderKeypair } = loadWallet();

  // Create TWO fresh keypairs for clean test (no existing stats accounts)
  const challengerKeypair = Keypair.generate();
  const acceptorKeypair = Keypair.generate();

  console.log("=== PvP Full Flow Test ===\n");
  console.log("Funder:", funderKeypair.publicKey.toString());
  console.log("Challenger:", challengerKeypair.publicKey.toString());
  console.log("Acceptor:", acceptorKeypair.publicKey.toString());

  // Connect to devnet
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");

  // Fund both participants from main wallet
  console.log("\n--- Funding Participants ---");
  const fundTx = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.transfer({
      fromPubkey: funderKeypair.publicKey,
      toPubkey: challengerKeypair.publicKey,
      lamports: 0.02 * LAMPORTS_PER_SOL,
    }),
    anchor.web3.SystemProgram.transfer({
      fromPubkey: funderKeypair.publicKey,
      toPubkey: acceptorKeypair.publicKey,
      lamports: 0.02 * LAMPORTS_PER_SOL,
    })
  );
  fundTx.feePayer = funderKeypair.publicKey;
  fundTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  fundTx.sign(funderKeypair);
  const fundSig = await connection.sendRawTransaction(fundTx.serialize());
  await connection.confirmTransaction(fundSig, "confirmed");
  console.log("Funded challenger with 0.02 SOL");
  console.log("Funded acceptor with 0.02 SOL");

  // Wait for funding to propagate
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Verify funding
  const challengerBal = await connection.getBalance(challengerKeypair.publicKey);
  const acceptorBal = await connection.getBalance(acceptorKeypair.publicKey);
  console.log("Challenger balance:", challengerBal / LAMPORTS_PER_SOL, "SOL");
  console.log("Acceptor balance:", acceptorBal / LAMPORTS_PER_SOL, "SOL");

  // Setup challenger provider
  const challengerWallet = new anchor.Wallet(challengerKeypair);
  const challengerProvider = new anchor.AnchorProvider(connection, challengerWallet, { commitment: "confirmed" });

  // Setup acceptor provider
  const acceptorWallet = new anchor.Wallet(acceptorKeypair);
  const acceptorProvider = new anchor.AnchorProvider(connection, acceptorWallet, { commitment: "confirmed" });

  // Load IDL
  const idlPath = path.join(__dirname, "../target/idl/agent_casino.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  // Derive house PDA
  const [housePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("house")],
    PROGRAM_ID
  );

  // ===== STEP 1: CREATE CHALLENGE =====
  console.log("\n--- Step 1: Create Challenge ---");
  anchor.setProvider(challengerProvider);
  const challengerProgram = new anchor.Program(idl, challengerProvider) as any;

  const nonce = new anchor.BN(Date.now());
  const [challengePda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("challenge"),
      challengerKeypair.publicKey.toBuffer(),
      nonce.toArrayLike(Buffer, "le", 8)
    ],
    PROGRAM_ID
  );

  const amount = new anchor.BN(0.005 * LAMPORTS_PER_SOL);
  const choice = 0; // Challenger picks HEADS

  const createTx = await challengerProgram.methods
    .createChallenge(amount, choice, nonce)
    .accounts({
      house: housePda,
      challenge: challengePda,
      challenger: challengerKeypair.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log("Challenge created:", challengePda.toString());
  console.log("Challenger picked: HEADS");
  console.log("Amount:", amount.toNumber() / LAMPORTS_PER_SOL, "SOL");

  // ===== STEP 2: ACCEPT CHALLENGE =====
  console.log("\n--- Step 2: Accept Challenge ---");
  anchor.setProvider(acceptorProvider);
  const acceptorProgram = new anchor.Program(idl, acceptorProvider) as any;

  const [challengerStatsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), challengerKeypair.publicKey.toBuffer()],
    PROGRAM_ID
  );

  const [acceptorStatsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), acceptorKeypair.publicKey.toBuffer()],
    PROGRAM_ID
  );

  const clientSeed = crypto.randomBytes(32);

  const acceptTx = await acceptorProgram.methods
    .acceptChallenge(Array.from(clientSeed))
    .accounts({
      house: housePda,
      challenge: challengePda,
      challenger: challengerKeypair.publicKey,
      challengerStats: challengerStatsPda,
      acceptorStats: acceptorStatsPda,
      acceptor: acceptorKeypair.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log("Challenge accepted!");
  console.log("Transaction:", acceptTx);

  // Wait and fetch result
  await new Promise(resolve => setTimeout(resolve, 2000));

  const completedChallenge = await acceptorProgram.account.challenge.fetch(challengePda);

  console.log("\n=== RESULT ===");
  console.log("Flip result:", completedChallenge.result === 0 ? "HEADS" : "TAILS");
  console.log("Winner:", completedChallenge.winner.toString());

  const challengerWon = completedChallenge.winner.toString() === challengerKeypair.publicKey.toString();
  console.log(challengerWon ? "Challenger won!" : "Acceptor won!");

  // Show final balances
  const challengerBalance = await connection.getBalance(challengerKeypair.publicKey);
  const acceptorBalance = await connection.getBalance(acceptorKeypair.publicKey);

  console.log("\n--- Final Balances ---");
  console.log("Challenger:", challengerBalance / LAMPORTS_PER_SOL, "SOL");
  console.log("Acceptor:", acceptorBalance / LAMPORTS_PER_SOL, "SOL");

  // Pot info
  const totalPot = 0.01; // 2 x 0.005 SOL
  const houseTake = totalPot * 0.01;
  const winnerPayout = totalPot - houseTake;
  console.log("\nTotal pot:", totalPot, "SOL");
  console.log("House take (1%):", houseTake, "SOL");
  console.log("Winner received:", winnerPayout, "SOL");

  console.log("\n=== PvP Test Complete ===");
}

main().catch(console.error);
