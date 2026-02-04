import { loadWallet, isAgentWalletConfigured } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  const betAmountArg = process.argv[2];
  const cashoutMultiplierArg = process.argv[3];

  if (!betAmountArg || !cashoutMultiplierArg) {
    console.log("Usage: npx ts-node scripts/play-crash.ts <BET_SOL> <CASHOUT_MULTIPLIER>");
    console.log("\nExamples:");
    console.log("  npx ts-node scripts/play-crash.ts 0.002 1.5   # Cash out at 1.5x");
    console.log("  npx ts-node scripts/play-crash.ts 0.001 2.0   # Cash out at 2x");
    console.log("  npx ts-node scripts/play-crash.ts 0.001 10.0  # Risky - cash out at 10x");
    console.log("\nCashout multiplier range: 1.01 - 100");
    console.log("Win if crash point >= your cashout multiplier");
    console.log("Most games crash between 1x-3x, but can occasionally go 50x+");
    process.exit(1);
  }

  const betAmount = parseFloat(betAmountArg);
  const cashoutMultiplier = parseFloat(cashoutMultiplierArg);

  if (isNaN(betAmount) || betAmount <= 0) {
    console.error("Invalid bet amount");
    process.exit(1);
  }

  if (isNaN(cashoutMultiplier) || cashoutMultiplier < 1.01 || cashoutMultiplier > 100) {
    console.error("Cashout multiplier must be between 1.01 and 100");
    process.exit(1);
  }

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
  const betLamports = new anchor.BN(Math.floor(betAmount * LAMPORTS_PER_SOL));
  const cashoutBps = Math.floor(cashoutMultiplier * 100); // 1.5x -> 150
  const clientSeed = crypto.randomBytes(32);

  console.log("\n--- Playing Crash ---");
  console.log("Bet:", betAmount, "SOL");
  console.log("Cashout target:", cashoutMultiplier + "x");
  console.log("Potential payout:", (betAmount * cashoutMultiplier).toFixed(4), "SOL");
  console.log("Client Seed:", clientSeed.toString("hex").slice(0, 16) + "...");

  // Get balance before
  const balanceBefore = await connection.getBalance(walletKeypair.publicKey);

  try {
    const tx = await program.methods
      .crash(betLamports, cashoutBps, Array.from(clientSeed))
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
    const crashPoint = (gameRecord.result << 8) / 100; // Decode crash point
    const payout = gameRecord.payout.toNumber();
    const won = payout > 0;

    console.log("\n--- Result ---");
    console.log("Crash point:", (crashPoint || gameRecord.result / 100 * 256).toFixed(2) + "x");
    console.log("Your cashout:", cashoutMultiplier + "x");
    console.log(won ? "YOU WON! Cashed out before crash!" : "CRASHED! Game crashed before your cashout");
    if (won) {
      console.log("Payout:", payout / LAMPORTS_PER_SOL, "SOL");
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
    console.error("\nError playing crash:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
