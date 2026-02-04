import { loadWallet, isAgentWalletConfigured } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  const pullPriceSol = parseFloat(process.argv[2]) || 0.02;
  const houseEdgeBps = parseInt(process.argv[3]) || 1000; // 10% default

  console.log("=== CREATE MEMORY POOL ===\n");
  console.log("Pull Price:", pullPriceSol, "SOL");
  console.log("House Edge:", houseEdgeBps / 100, "%");
  console.log("Stake Amount: 0.01 SOL (fixed)\n");

  // Load wallet
  // Load wallet (AgentWallet aware)
  const { keypair: walletKeypair } = loadWallet();
  console.log("Authority:", walletKeypair.publicKey.toString());

  // Connect to devnet
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // Load IDL
  const idlPath = path.join(__dirname, "../target/idl/agent_casino.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider) as any;

  // Derive memory pool PDA
  const [memoryPoolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("memory_pool")],
    PROGRAM_ID
  );
  console.log("Memory Pool PDA:", memoryPoolPda.toString());

  try {
    const pullPrice = new anchor.BN(pullPriceSol * LAMPORTS_PER_SOL);

    const tx = await program.methods
      .createMemoryPool(pullPrice, houseEdgeBps)
      .accounts({
        memoryPool: memoryPoolPda,
        authority: walletKeypair.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("\nMemory Pool created!");
    console.log("Transaction:", tx);
    console.log("\n=== POOL INFO ===");
    console.log("Pool Address:", memoryPoolPda.toString());
    console.log("\nHow to deposit memory:");
    console.log('  npx ts-node scripts/memory-deposit.ts "Your knowledge here" strategy common');

  } catch (e: any) {
    console.error("\nError creating memory pool:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
