/**
 * Claim lottery prize (winner only)
 *
 * Usage: npx ts-node scripts/lottery-claim.ts <lottery_address> <ticket_number>
 */

import { Connection, clusterApiUrl, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgentCasino } from "../sdk/src";
import { loadWallet } from "./utils/wallet";

async function main() {
  const lotteryAddress = process.argv[2];
  const ticketNumber = parseInt(process.argv[3], 10);

  if (!lotteryAddress || isNaN(ticketNumber)) {
    console.error("Usage: npx ts-node scripts/lottery-claim.ts <lottery_address> <ticket_number>");
    process.exit(1);
  }

  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const { keypair, address } = loadWallet();
  const casino = new AgentCasino(connection, keypair);

  const info = await casino.getLotteryInfo(lotteryAddress);
  console.log("=== Claim Lottery Prize ===");
  console.log(`Lottery: ${lotteryAddress}`);
  console.log(`Status: ${info.status} | Winner: Ticket #${info.winnerTicket}`);
  console.log(`Pool: ${info.totalPool} SOL`);
  console.log(`Your ticket: #${ticketNumber}`);
  console.log();

  if (info.winnerTicket !== ticketNumber) {
    console.error(`Ticket #${ticketNumber} is not the winner (winner is #${info.winnerTicket})`);
    process.exit(1);
  }

  try {
    const balanceBefore = await connection.getBalance(keypair.publicKey);
    const result = await casino.claimLotteryPrize(lotteryAddress, ticketNumber);
    const balanceAfter = await connection.getBalance(keypair.publicKey);
    const netGain = (balanceAfter - balanceBefore) / LAMPORTS_PER_SOL;

    console.log("Prize claimed!");
    console.log(`  Prize: ${result.prize.toFixed(6)} SOL`);
    console.log(`  Net gain: ${netGain >= 0 ? "+" : ""}${netGain.toFixed(6)} SOL`);
    console.log(`  TX: ${result.tx}`);
  } catch (err: any) {
    console.error("Error:", err.message);
    if (err.logs) err.logs.forEach((l: string) => console.log(l));
  }
}

main().catch(console.error);
