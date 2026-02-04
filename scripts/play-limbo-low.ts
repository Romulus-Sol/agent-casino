import { loadWallet, isAgentWalletConfigured } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  // Load wallet (AgentWallet aware)
  const { keypair: walletKeypair } = loadWallet();

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idlPath = path.join(__dirname, "../target/idl/agent_casino.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider) as any;

  const [housePda] = PublicKey.findProgramAddressSync([Buffer.from("house")], PROGRAM_ID);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), housePda.toBuffer()], PROGRAM_ID);
  const [agentStatsPda] = PublicKey.findProgramAddressSync([Buffer.from("agent"), walletKeypair.publicKey.toBuffer()], PROGRAM_ID);

  const house = await program.account.house.fetch(housePda);
  const gameIndex = house.totalGames;

  const [gameRecordPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), housePda.toBuffer(), new anchor.BN(gameIndex).toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  );

  const betAmount = new anchor.BN(0.002 * LAMPORTS_PER_SOL);
  const targetMultiplier = 110; // 1.10x - very high win chance (~90%)
  const clientSeed = crypto.randomBytes(32);

  console.log("Target: 1.10x (should win ~90% of time)");

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

    await new Promise(resolve => setTimeout(resolve, 2000));

    const gameRecord = await program.account.gameRecord.fetch(gameRecordPda);
    const payout = gameRecord.payout.toNumber();
    const won = payout > 0;

    console.log(won ? "WON! Payout: " + (payout / LAMPORTS_PER_SOL) + " SOL" : "Lost");
  } catch (e: any) {
    console.error("Error:", e.message);
  }
}

main().catch(console.error);
