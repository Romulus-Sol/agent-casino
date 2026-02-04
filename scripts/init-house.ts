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
  console.log("Wallet:", walletKeypair.publicKey.toString());

  // Connect to devnet
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // Load IDL
  const idlPath = path.join(__dirname, "../target/idl/agent_casino.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  // Create program with explicit typing workaround
  const program = new anchor.Program(idl, provider) as any;

  // Derive PDAs
  const [housePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("house")],
    PROGRAM_ID
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), housePda.toBuffer()],
    PROGRAM_ID
  );
  const [lpPositionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), housePda.toBuffer(), walletKeypair.publicKey.toBuffer()],
    PROGRAM_ID
  );

  console.log("House PDA:", housePda.toString());
  console.log("Vault PDA:", vaultPda.toString());

  // Check if house already exists
  const houseAccount = await connection.getAccountInfo(housePda);

  if (!houseAccount) {
    console.log("\n--- Initializing House ---");
    const houseEdgeBps = 100; // 1% house edge
    const minBet = new anchor.BN(0.001 * LAMPORTS_PER_SOL); // 0.001 SOL min bet
    const maxBetPercent = 2; // 2% of pool max bet

    try {
      const tx = await program.methods
        .initializeHouse(houseEdgeBps, minBet, maxBetPercent)
        .accounts({
          house: housePda,
          houseVault: vaultPda,
          authority: walletKeypair.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      console.log("House initialized! Tx:", tx);

      // Wait for confirmation
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (e: any) {
      console.error("Error initializing house:", e.message);
      if (e.logs) console.log("Logs:", e.logs);
      return;
    }
  } else {
    console.log("\nHouse already initialized");
  }

  // Add liquidity
  console.log("\n--- Adding Liquidity ---");
  const liquidityAmount = new anchor.BN(0.2 * LAMPORTS_PER_SOL); // 0.2 SOL

  try {
    const tx = await program.methods
      .addLiquidity(liquidityAmount)
      .accounts({
        house: housePda,
        houseVault: vaultPda,
        lpPosition: lpPositionPda,
        provider: walletKeypair.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("Liquidity added! Tx:", tx);
    console.log(`Added 0.2 SOL to the house pool`);
  } catch (e: any) {
    console.error("Error adding liquidity:", e.message);
    if (e.logs) console.log("Logs:", e.logs);
    return;
  }

  // Fetch and display house stats
  console.log("\n--- House Stats ---");
  try {
    const house = await program.account.house.fetch(housePda);
    console.log("Pool:", house.pool.toNumber() / LAMPORTS_PER_SOL, "SOL");
    console.log("House Edge:", house.houseEdgeBps / 100, "%");
    console.log("Min Bet:", house.minBet.toNumber() / LAMPORTS_PER_SOL, "SOL");
    console.log("Max Bet %:", house.maxBetPercent, "%");
    console.log("Total Games:", house.totalGames.toString());
    console.log("Total Volume:", house.totalVolume.toNumber() / LAMPORTS_PER_SOL, "SOL");
  } catch (e: any) {
    console.error("Error fetching house:", e.message);
  }
}

main().catch(console.error);
