import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  // Set up provider from environment
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  console.log("Wallet:", provider.wallet.publicKey.toString());
  console.log("Program ID:", PROGRAM_ID.toString());

  // Derive PDAs
  const [housePda, houseBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("house")],
    PROGRAM_ID
  );
  const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), housePda.toBuffer()],
    PROGRAM_ID
  );

  console.log("House PDA:", housePda.toString());
  console.log("Vault PDA:", vaultPda.toString());

  // Check if house already exists
  const houseAccount = await provider.connection.getAccountInfo(housePda);
  if (houseAccount) {
    console.log("House already initialized!");
    console.log("Account size:", houseAccount.data.length, "bytes");
    process.exit(0);
  }

  // Initialize house parameters
  const houseEdgeBps = 100; // 1% house edge
  const minBet = new anchor.BN(10_000_000); // 0.01 SOL
  const maxBetPercent = 5; // 5% of pool max bet

  // Build the initialize_house instruction manually
  // Discriminator for initialize_house (first 8 bytes of sha256("global:initialize_house"))
  const discriminator = Buffer.from([0xd6, 0x4d, 0x3a, 0x41, 0x42, 0x66, 0xde, 0x26]);

  const data = Buffer.concat([
    discriminator,
    Buffer.from(new Uint16Array([houseEdgeBps]).buffer), // u16
    minBet.toArrayLike(Buffer, "le", 8), // u64
    Buffer.from([maxBetPercent]), // u8
  ]);

  const ix = new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: housePda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: false },
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  console.log("\nInitializing house with:");
  console.log("  House Edge: 1% (100 bps)");
  console.log("  Min Bet: 0.01 SOL");
  console.log("  Max Bet: 5% of pool");

  try {
    const tx = new anchor.web3.Transaction().add(ix);
    const sig = await provider.sendAndConfirm(tx);
    console.log("\n✅ House initialized!");
    console.log("Transaction:", sig);
  } catch (e: any) {
    console.error("\n❌ Failed to initialize:", e.message);
    if (e.logs) {
      console.log("\nLogs:");
      e.logs.forEach((log: string) => console.log("  ", log));
    }
  }
}

main().catch(console.error);
