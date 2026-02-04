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
  const revealFilePath = process.argv[2];

  if (!revealFilePath) {
    console.log("Usage: npx ts-node scripts/open-market-reveal.ts <REVEAL_FILE>");
    console.log("Example: npx ts-node scripts/open-market-reveal.ts reveal-open-7xK12345-Abc12345.json");
    console.log("\nThe reveal file was created when you committed your bet.");
    process.exit(1);
  }

  // Load reveal info
  let revealInfo;
  try {
    revealInfo = JSON.parse(fs.readFileSync(revealFilePath, "utf-8"));
  } catch (e) {
    console.error("Could not read reveal file:", revealFilePath);
    process.exit(1);
  }

  console.log("\n--- Reveal Info ---");
  console.log("Market:", revealInfo.market);
  console.log("Predicted Project:", revealInfo.predictedProject);
  console.log("Amount:", revealInfo.amount, "SOL");
  console.log("Bettor:", revealInfo.bettor);

  const marketPda = new PublicKey(revealInfo.market);
  const predictedProject = revealInfo.predictedProject;
  const salt = Buffer.from(revealInfo.salt, 'hex');

  // Load wallet
  const walletPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const walletKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );

  if (walletKeypair.publicKey.toString() !== revealInfo.bettor) {
    console.error("\n❌ Wallet does not match bettor in reveal file!");
    console.error("Expected:", revealInfo.bettor);
    console.error("Got:", walletKeypair.publicKey.toString());
    process.exit(1);
  }

  // Connect to devnet
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // Load IDL
  const idlPath = path.join(__dirname, "../target/idl/agent_casino.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider) as any;

  // Derive bet PDA
  const [betPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pred_bet"), marketPda.toBuffer(), walletKeypair.publicKey.toBuffer()],
    PROGRAM_ID
  );

  // Fetch market
  let market;
  try {
    market = await program.account.predictionMarket.fetch(marketPda);
  } catch (e) {
    console.error("Market not found:", revealInfo.market);
    process.exit(1);
  }

  console.log("\n--- Market Status ---");
  console.log("Question:", decodeBytes(market.question));
  console.log("Status:", Object.keys(market.status)[0]);

  const status = Object.keys(market.status)[0];
  if (status !== "revealing") {
    if (status === "committing") {
      console.log("\n⏳ Market still in commit phase. Wait until:",
        new Date(market.commitDeadline.toNumber() * 1000).toISOString());
      console.log("Then call: npx ts-node scripts/prediction-start-reveal.ts", marketPda.toString());
    } else {
      console.log("\n❌ Market is in", status, "phase");
    }
    process.exit(0);
  }

  const clock = Math.floor(Date.now() / 1000);
  if (clock >= market.revealDeadline.toNumber()) {
    console.error("\n❌ Reveal phase has ended! Your bet is forfeited.");
    process.exit(1);
  }

  console.log("\n--- Revealing Bet ---");
  console.log("Project:", predictedProject);

  try {
    const tx = await program.methods
      .revealPredictionBet(predictedProject, Array.from(salt))
      .accounts({
        market: marketPda,
        bet: betPda,
        bettor: walletKeypair.publicKey,
      })
      .rpc();

    console.log("\n✅ Bet revealed!");
    console.log("Transaction:", tx);
    console.log("\nYour prediction:", predictedProject);
    console.log("\nWait for market resolution to claim winnings if you predicted correctly!");

  } catch (e: any) {
    console.error("\nError revealing bet:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log(log));
    }
  }
}

main().catch(console.error);
