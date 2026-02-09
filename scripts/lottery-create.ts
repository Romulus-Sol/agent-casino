/**
 * Create a new lottery pool
 *
 * Usage: npx ts-node scripts/lottery-create.ts <ticket_price_sol> <max_tickets> <duration_slots>
 *   ticket_price_sol: Price per ticket in SOL (e.g., 0.01)
 *   max_tickets: Maximum number of tickets (2-1000)
 *   duration_slots: How many slots until ticket sales end (~400ms each)
 *
 * Example: npx ts-node scripts/lottery-create.ts 0.01 10 1000
 */

import { Connection, clusterApiUrl } from "@solana/web3.js";
import { AgentCasino } from "../sdk/src";
import { loadWallet } from "./utils/wallet";

async function main() {
  const ticketPriceSol = parseFloat(process.argv[2] || "0.01");
  const maxTickets = parseInt(process.argv[3] || "10", 10);
  const durationSlots = parseInt(process.argv[4] || "1000", 10);

  if (isNaN(ticketPriceSol) || ticketPriceSol <= 0) {
    console.error("Usage: npx ts-node scripts/lottery-create.ts <ticket_price_sol> <max_tickets> <duration_slots>");
    process.exit(1);
  }

  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const { keypair, address } = loadWallet();
  const casino = new AgentCasino(connection, keypair);

  // Get current slot to calculate end_slot
  const currentSlot = await connection.getSlot();
  const endSlot = currentSlot + durationSlots;

  console.log("=== Create Lottery ===");
  console.log(`Creator: ${address}`);
  console.log(`Ticket Price: ${ticketPriceSol} SOL`);
  console.log(`Max Tickets: ${maxTickets}`);
  console.log(`Current Slot: ${currentSlot}`);
  console.log(`End Slot: ${endSlot} (in ~${Math.round(durationSlots * 0.4)}s)`);
  console.log();

  try {
    const result = await casino.createLottery(ticketPriceSol, maxTickets, endSlot);
    console.log("Lottery created!");
    console.log(`  Address: ${result.lotteryAddress}`);
    console.log(`  Index: ${result.lotteryIndex}`);
    console.log(`  TX: ${result.tx}`);
    console.log();
    console.log(`Buy a ticket: npx ts-node scripts/lottery-buy.ts ${result.lotteryAddress}`);
    console.log(`View lottery:  npx ts-node scripts/lottery-view.ts ${result.lotteryAddress}`);
  } catch (err: any) {
    console.error("Error:", err.message);
    if (err.logs) err.logs.forEach((l: string) => console.log(l));
  }
}

main().catch(console.error);
