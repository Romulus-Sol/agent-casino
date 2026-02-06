import * as anchor from "@coral-xyz/anchor";
import { PublicKey, LAMPORTS_PER_SOL, Connection, clusterApiUrl } from "@solana/web3.js";
import { loadWallet } from "./utils/wallet";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

async function main() {
  const walletConfig = loadWallet();
  const connection = new Connection(
    process.env.ANCHOR_PROVIDER_URL || clusterApiUrl("devnet"),
    "confirmed"
  );
  const wallet = new anchor.Wallet(walletConfig.keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  anchor.setProvider(provider);

  const [housePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("house")],
    PROGRAM_ID
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), housePda.toBuffer()],
    PROGRAM_ID
  );

  const houseAccount = await provider.connection.getAccountInfo(housePda);
  if (!houseAccount) {
    console.log("House not initialized");
    return;
  }

  // Parse house data (skip 8-byte discriminator)
  const data = houseAccount.data;
  let offset = 8;

  const authority = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const pool = data.readBigUInt64LE(offset);
  offset += 8;

  const houseEdgeBps = data.readUInt16LE(offset);
  offset += 2;

  const minBet = data.readBigUInt64LE(offset);
  offset += 8;

  const maxBetPercent = data[offset];
  offset += 1;

  const totalGames = data.readBigUInt64LE(offset);
  offset += 8;

  const totalVolume = data.readBigUInt64LE(offset);
  offset += 8;

  const totalPayout = data.readBigUInt64LE(offset);

  // Get vault balance
  const vaultBalance = await provider.connection.getBalance(vaultPda);

  console.log("=== Agent Casino House Status ===\n");
  console.log("House PDA:", housePda.toString());
  console.log("Vault PDA:", vaultPda.toString());
  console.log("Authority:", authority.toString());
  console.log("");
  console.log("Configuration:");
  console.log("  House Edge:", (houseEdgeBps / 100).toFixed(2) + "%");
  console.log("  Min Bet:", (Number(minBet) / LAMPORTS_PER_SOL).toFixed(4), "SOL");
  console.log("  Max Bet:", maxBetPercent + "% of pool");
  console.log("");
  console.log("Pool Status:");
  console.log("  Pool (tracked):", (Number(pool) / LAMPORTS_PER_SOL).toFixed(4), "SOL");
  console.log("  Vault Balance:", (vaultBalance / LAMPORTS_PER_SOL).toFixed(4), "SOL");
  console.log("  Max Bet Amount:", ((Number(pool) * maxBetPercent / 100) / LAMPORTS_PER_SOL).toFixed(4), "SOL");
  console.log("");
  console.log("Stats:");
  console.log("  Total Games:", totalGames.toString());
  console.log("  Total Volume:", (Number(totalVolume) / LAMPORTS_PER_SOL).toFixed(4), "SOL");
  console.log("  Total Payout:", (Number(totalPayout) / LAMPORTS_PER_SOL).toFixed(4), "SOL");
  console.log("  House Profit:", ((Number(totalVolume) - Number(totalPayout)) / LAMPORTS_PER_SOL).toFixed(4), "SOL");
}

main().catch(console.error);
