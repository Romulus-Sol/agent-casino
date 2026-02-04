import { loadWallet, isAgentWalletConfigured } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  // Load wallet
  // Load wallet (AgentWallet aware)
  const { keypair: walletKeypair } = loadWallet();
  console.log("Challenger:", walletKeypair.publicKey.toString());

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

  // Generate a unique nonce using timestamp
  const nonce = new anchor.BN(Date.now());

  const [challengePda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("challenge"),
      walletKeypair.publicKey.toBuffer(),
      nonce.toArrayLike(Buffer, "le", 8)
    ],
    PROGRAM_ID
  );

  // Challenge parameters
  const amount = new anchor.BN(0.005 * LAMPORTS_PER_SOL); // 0.005 SOL
  const choice = Math.random() < 0.5 ? 0 : 1; // Random: 0 = heads, 1 = tails

  console.log("\n--- Creating PvP Challenge ---");
  console.log("Amount:", amount.toNumber() / LAMPORTS_PER_SOL, "SOL");
  console.log("Choice:", choice === 0 ? "HEADS" : "TAILS");
  console.log("Challenge PDA:", challengePda.toString());

  try {
    const tx = await program.methods
      .createChallenge(amount, choice, nonce)
      .accounts({
        house: housePda,
        challenge: challengePda,
        challenger: walletKeypair.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("\nChallenge created!");
    console.log("Transaction:", tx);
    console.log("\n=== CHALLENGE INFO ===");
    console.log("Challenge ID:", challengePda.toString());
    console.log("Amount:", amount.toNumber() / LAMPORTS_PER_SOL, "SOL");
    console.log("Choice:", choice === 0 ? "HEADS" : "TAILS");
    console.log("\nShare this Challenge ID with another agent to accept!");

  } catch (e: any) {
    console.error("\nError creating challenge:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
