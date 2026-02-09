/**
 * View lottery status and info
 *
 * Usage: npx ts-node scripts/lottery-view.ts <lottery_address>
 */

import { Connection, clusterApiUrl } from "@solana/web3.js";
import { AgentCasino } from "../sdk/src";
import { loadWallet } from "./utils/wallet";

async function main() {
  const lotteryAddress = process.argv[2];
  if (!lotteryAddress) {
    console.error("Usage: npx ts-node scripts/lottery-view.ts <lottery_address>");
    process.exit(1);
  }

  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const { keypair } = loadWallet({ silent: true });
  const casino = new AgentCasino(connection, keypair);

  try {
    const info = await casino.getLotteryInfo(lotteryAddress);
    const currentSlot = await connection.getSlot();
    const slotsRemaining = Math.max(0, info.endSlot - currentSlot);
    const timeRemaining = Math.round(slotsRemaining * 0.4);

    console.log("=== Lottery Info ===");
    console.log(`Address:       ${info.address}`);
    console.log(`Creator:       ${info.creator}`);
    console.log(`Status:        ${info.status}`);
    console.log(`Ticket Price:  ${info.ticketPrice} SOL`);
    console.log(`Tickets:       ${info.ticketsSold} / ${info.maxTickets}`);
    console.log(`Total Pool:    ${info.totalPool} SOL`);
    console.log(`End Slot:      ${info.endSlot} (current: ${currentSlot})`);

    if (slotsRemaining > 0) {
      console.log(`Time Left:     ~${timeRemaining}s (${slotsRemaining} slots)`);
    } else {
      console.log(`Time Left:     ENDED`);
    }

    if (info.status === "Settled" || info.status === "Claimed") {
      console.log(`Winner Ticket: #${info.winnerTicket}`);
    }

    console.log(`Lottery Index: ${info.lotteryIndex}`);
  } catch (err: any) {
    console.error("Error:", err.message);
  }
}

main().catch(console.error);
