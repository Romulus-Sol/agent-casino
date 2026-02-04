import { loadWallet, isAgentWalletConfigured } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  const memoryAddress = process.argv[2];

  if (!memoryAddress) {
    console.log("Usage: npx ts-node scripts/memory-withdraw.ts <MEMORY_ADDRESS>");
    console.log("\nNote: Can only withdraw memories that haven't been pulled yet.");
    console.log("5% withdrawal fee applies.");
    console.log("\nTo see your deposited memories:");
    console.log("  npx ts-node scripts/memory-my-deposits.ts");
    process.exit(1);
  }

  console.log("=== WITHDRAW MEMORY ===\n");
  console.log("Memory Address:", memoryAddress);

  // Load wallet
  // Load wallet (AgentWallet aware)
  const { keypair: walletKeypair } = loadWallet();
  console.log("Depositor:", walletKeypair.publicKey.toString());

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

  const memoryPubkey = new PublicKey(memoryAddress);

  try {
    // Fetch memory to check status
    const memory = await program.account.memory.fetch(memoryPubkey);

    if (!memory.active) {
      console.error("\nError: Memory is no longer active (already withdrawn).");
      process.exit(1);
    }

    if (memory.timesPulled.toNumber() > 0) {
      console.error("\nError: Cannot withdraw - memory has already been pulled", memory.timesPulled.toString(), "times.");
      process.exit(1);
    }

    if (!memory.depositor.equals(walletKeypair.publicKey)) {
      console.error("\nError: You are not the depositor of this memory.");
      process.exit(1);
    }

    const stake = memory.stake.toNumber() / LAMPORTS_PER_SOL;
    const fee = stake * 0.05;
    const refund = stake - fee;

    console.log("\nStake:", stake, "SOL");
    console.log("Withdrawal Fee (5%):", fee.toFixed(4), "SOL");
    console.log("Refund:", refund.toFixed(4), "SOL");

    const tx = await program.methods
      .withdrawMemory()
      .accounts({
        memoryPool: memoryPoolPda,
        memory: memoryPubkey,
        depositor: walletKeypair.publicKey,
      })
      .rpc();

    console.log("\nMemory withdrawn!");
    console.log("Transaction:", tx);
    console.log("\nRefund received:", refund.toFixed(4), "SOL");

  } catch (e: any) {
    console.error("\nError withdrawing memory:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
