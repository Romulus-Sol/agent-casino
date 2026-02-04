import { loadWallet, isAgentWalletConfigured } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  // Load wallet
  // Load wallet (AgentWallet aware)
  const { keypair: walletKeypair } = loadWallet();
  console.log("Player:", walletKeypair.publicKey.toString());

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
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), housePda.toBuffer()],
    PROGRAM_ID
  );
  const [agentStatsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), walletKeypair.publicKey.toBuffer()],
    PROGRAM_ID
  );

  // Get current house stats to determine game index
  const house = await program.account.house.fetch(housePda);
  const gameIndex = house.totalGames;

  const [gameRecordPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), housePda.toBuffer(), new anchor.BN(gameIndex).toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  );

  // Game parameters
  const betAmount = new anchor.BN(0.002 * LAMPORTS_PER_SOL); // 0.002 SOL bet
  const target = Math.floor(Math.random() * 5) + 1; // Random target 1-5
  const clientSeed = crypto.randomBytes(32);

  // Calculate expected multiplier: 6/target (e.g., target=1 -> 6x, target=3 -> 2x)
  const expectedMultiplier = (6 / target).toFixed(2);

  console.log("\n--- Playing Dice Roll ---");
  console.log("Bet:", betAmount.toNumber() / LAMPORTS_PER_SOL, "SOL");
  console.log("Target:", target, `(win if roll <= ${target}, ~${expectedMultiplier}x payout)`);
  console.log("Win chance:", ((target / 6) * 100).toFixed(1) + "%");
  console.log("Client Seed:", clientSeed.toString("hex").slice(0, 16) + "...");

  // Get balance before
  const balanceBefore = await connection.getBalance(walletKeypair.publicKey);

  try {
    const tx = await program.methods
      .diceRoll(betAmount, target, Array.from(clientSeed))
      .accounts({
        house: housePda,
        houseVault: vaultPda,
        gameRecord: gameRecordPda,
        agentStats: agentStatsPda,
        player: walletKeypair.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("\nTransaction:", tx);

    // Wait for confirmation
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Fetch game record
    const gameRecord = await program.account.gameRecord.fetch(gameRecordPda);
    const result = gameRecord.result;
    const payout = gameRecord.payout.toNumber();
    const won = payout > 0;

    console.log("\n--- Result ---");
    console.log("Dice rolled:", result);
    console.log("Target was:", target, `(needed <= ${target})`);
    console.log(won ? "YOU WON!" : "You lost");
    if (won) {
      console.log("Payout:", payout / LAMPORTS_PER_SOL, "SOL");
      console.log("Multiplier:", (payout / betAmount.toNumber()).toFixed(2) + "x");
    }

    // Get balance after
    const balanceAfter = await connection.getBalance(walletKeypair.publicKey);
    const netChange = (balanceAfter - balanceBefore) / LAMPORTS_PER_SOL;
    console.log("Net change:", netChange.toFixed(6), "SOL");

    // Show updated house stats
    console.log("\n--- Updated House Stats ---");
    const updatedHouse = await program.account.house.fetch(housePda);
    console.log("Pool:", updatedHouse.pool.toNumber() / LAMPORTS_PER_SOL, "SOL");
    console.log("Total Games:", updatedHouse.totalGames.toString());
    console.log("Total Volume:", updatedHouse.totalVolume.toNumber() / LAMPORTS_PER_SOL, "SOL");

  } catch (e: any) {
    console.error("\nError playing dice roll:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
