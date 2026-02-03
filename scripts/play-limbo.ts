import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  // Load wallet
  const walletPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const walletKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
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

  // Random target multiplier between 1.5x and 5x (150-500 in program units)
  const targetMultiplierFloat = 1.5 + Math.random() * 3.5;
  const targetMultiplier = Math.floor(targetMultiplierFloat * 100); // Convert to program format (e.g., 2.5x = 250)

  const clientSeed = crypto.randomBytes(32);

  // Win probability is roughly 1/multiplier (minus house edge)
  const winChance = (100 / targetMultiplierFloat).toFixed(1);

  console.log("\n--- Playing Limbo ---");
  console.log("Bet:", betAmount.toNumber() / LAMPORTS_PER_SOL, "SOL");
  console.log("Target Multiplier:", (targetMultiplier / 100).toFixed(2) + "x");
  console.log("Win chance: ~" + winChance + "%");
  console.log("Client Seed:", clientSeed.toString("hex").slice(0, 16) + "...");

  // Get balance before
  const balanceBefore = await connection.getBalance(walletKeypair.publicKey);

  try {
    const tx = await program.methods
      .limbo(betAmount, targetMultiplier, Array.from(clientSeed))
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
    const payout = gameRecord.payout.toNumber();
    const won = payout > 0;

    console.log("\n--- Result ---");
    console.log("Target:", (targetMultiplier / 100).toFixed(2) + "x");
    console.log(won ? "YOU WON!" : "You lost (result was below target)");
    if (won) {
      console.log("Payout:", payout / LAMPORTS_PER_SOL, "SOL");
      console.log("Actual Multiplier:", (payout / betAmount.toNumber()).toFixed(2) + "x");
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
    console.error("\nError playing limbo:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
