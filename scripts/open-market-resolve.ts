import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

// Helper to decode fixed-size byte arrays to strings
function decodeBytes(bytes: number[]): string {
  const end = bytes.indexOf(0);
  const validBytes = end >= 0 ? bytes.slice(0, end) : bytes;
  return Buffer.from(validBytes).toString('utf8');
}

async function main() {
  const marketIdStr = process.argv[2];
  const winningProject = process.argv[3];
  const winningPoolSol = parseFloat(process.argv[4]);

  if (!marketIdStr || !winningProject || isNaN(winningPoolSol)) {
    console.log("Usage: npx ts-node scripts/open-market-resolve.ts <MARKET_ID> <WINNING_PROJECT> <WINNING_POOL_SOL>");
    console.log("Example: npx ts-node scripts/open-market-resolve.ts 7xK... clodds 5.5");
    console.log("\nWINNING_POOL_SOL = sum of all revealed bets on the winning project");
    console.log("(Calculate this off-chain by summing revealed bets)");
    process.exit(1);
  }

  const marketPda = new PublicKey(marketIdStr);
  const winningPool = new anchor.BN(winningPoolSol * LAMPORTS_PER_SOL);

  // Load wallet (must be market authority)
  const walletPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const walletKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
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

  // Derive house PDA
  const [housePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("house")],
    PROGRAM_ID
  );

  // Fetch market
  let market;
  try {
    market = await program.account.predictionMarket.fetch(marketPda);
  } catch (e) {
    console.error("Market not found:", marketIdStr);
    process.exit(1);
  }

  console.log("\n--- Market Details ---");
  console.log("Question:", decodeBytes(market.question));
  console.log("Status:", Object.keys(market.status)[0]);
  console.log("Total Pool:", market.totalPool.toNumber() / LAMPORTS_PER_SOL, "SOL");
  console.log("Authority:", market.authority.toString());

  if (market.authority.toString() !== walletKeypair.publicKey.toString()) {
    console.error("\n❌ You are not the market authority!");
    process.exit(1);
  }

  const status = Object.keys(market.status)[0];
  if (status === "resolved") {
    console.log("\n⚠️  Market already resolved");
    console.log("Winning project:", market.winningProject);
    process.exit(0);
  }

  const clock = Math.floor(Date.now() / 1000);
  if (clock < market.revealDeadline.toNumber()) {
    const hoursLeft = (market.revealDeadline.toNumber() - clock) / 3600;
    console.log(`\n⏳ Reveal phase still active. ${hoursLeft.toFixed(1)} hours remaining.`);
    console.log("Wait until:", new Date(market.revealDeadline.toNumber() * 1000).toISOString());
    process.exit(0);
  }

  console.log("\n--- Resolving Market ---");
  console.log("Winning Project:", winningProject);
  console.log("Winning Pool:", winningPoolSol, "SOL");

  try {
    const tx = await program.methods
      .resolvePredictionMarket(winningProject, winningPool)
      .accounts({
        house: housePda,
        market: marketPda,
        authority: walletKeypair.publicKey,
      })
      .rpc();

    console.log("\n✅ Market resolved!");
    console.log("Transaction:", tx);
    console.log("\nWinning project:", winningProject);
    console.log("Winners can now claim their winnings!");

  } catch (e: any) {
    console.error("\nError resolving market:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
