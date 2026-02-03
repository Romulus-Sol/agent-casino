import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  const args = process.argv.slice(2);
  const amountSol = parseFloat(args[0] || "1");

  if (isNaN(amountSol) || amountSol <= 0) {
    console.log("Usage: npx ts-node scripts/add-liquidity.ts <amount_in_sol>");
    process.exit(1);
  }

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

  console.log("Adding liquidity to Agent Casino...\n");
  console.log("Wallet:", provider.wallet.publicKey.toString());
  console.log("Amount:", amountSol, "SOL");

  const [housePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("house")],
    PROGRAM_ID
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), housePda.toBuffer()],
    PROGRAM_ID
  );
  const [lpPositionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), housePda.toBuffer(), provider.wallet.publicKey.toBuffer()],
    PROGRAM_ID
  );

  // Correct discriminator from IDL: [181, 157, 89, 67, 143, 182, 52, 72]
  const discriminator = Buffer.from([181, 157, 89, 67, 143, 182, 52, 72]);

  const data = Buffer.concat([
    discriminator,
    new anchor.BN(amountLamports).toArrayLike(Buffer, "le", 8),
  ]);

  const ix = new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: housePda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: lpPositionPda, isSigner: false, isWritable: true },
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  try {
    const tx = new anchor.web3.Transaction().add(ix);
    const sig = await provider.sendAndConfirm(tx);

    console.log("\n✅ Liquidity added!");
    console.log("Transaction:", sig);

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    console.log("\nNew pool balance:", (vaultBalance / LAMPORTS_PER_SOL).toFixed(4), "SOL");
    console.log("New max bet:", ((vaultBalance * 0.02) / LAMPORTS_PER_SOL).toFixed(4), "SOL");
  } catch (e: any) {
    console.error("\n❌ Failed:", e.message);
    if (e.logs) {
      console.log("\nProgram logs:");
      e.logs.forEach((log: string) => console.log("  ", log));
    }
  }
}

main().catch(console.error);
