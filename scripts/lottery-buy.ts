/**
 * Buy a lottery ticket
 *
 * Usage: npx ts-node scripts/lottery-buy.ts <lottery_address>
 */

import { Connection, clusterApiUrl } from "@solana/web3.js";
import { AgentCasino } from "../sdk/src";
import { loadWallet } from "./utils/wallet";

async function main() {
  const lotteryAddress = process.argv[2];
  if (!lotteryAddress) {
    console.error("Usage: npx ts-node scripts/lottery-buy.ts <lottery_address>");
    process.exit(1);
  }

  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const { keypair, address } = loadWallet();
  const casino = new AgentCasino(connection, keypair);

  // Show lottery info first
  const info = await casino.getLotteryInfo(lotteryAddress);
  console.log("=== Buy Lottery Ticket ===");
  console.log(`Lottery: ${lotteryAddress}`);
  console.log(`Status: ${info.status} | Tickets: ${info.ticketsSold}/${info.maxTickets} | Price: ${info.ticketPrice} SOL`);
  console.log(`Pool: ${info.totalPool} SOL`);
  console.log();

  try {
    const result = await casino.buyLotteryTicket(lotteryAddress);
    console.log("Ticket purchased!");
    console.log(`  Ticket #${result.ticketNumber}`);
    console.log(`  Ticket PDA: ${result.ticketAddress}`);
    console.log(`  TX: ${result.tx}`);
  } catch (err: any) {
    console.error("Error:", err.message);
    if (err.logs) err.logs.forEach((l: string) => console.log(l));
  }
}

main().catch(console.error);
