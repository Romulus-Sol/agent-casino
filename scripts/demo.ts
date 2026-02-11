/**
 * Agent Casino — Full Feature Demo
 *
 * Showcases: house stats, VRF games, memory slots, hitman market, agent stats.
 * Each VRF game uses Switchboard VRF for provably fair randomness.
 * Solana-themed terminal colors (green/purple/teal gradient).
 *
 * Usage: npx ts-node scripts/demo.ts
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, ComputeBudgetProgram, clusterApiUrl } from "@solana/web3.js";
import { AgentCasino } from "../sdk/src";
import { loadWallet } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import * as sb from "@switchboard-xyz/on-demand";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

// ── Solana-Themed Terminal Colors (256-color) ──────────────────────
const R      = "\x1b[0m";        // Reset
const B      = "\x1b[1m";        // Bold
const DIM    = "\x1b[2m";        // Dim
const IT     = "\x1b[3m";        // Italic

// Solana brand palette (256-color foreground)
const SOL_GREEN  = "\x1b[38;5;49m";   // #14F195 — Solana mint green
const SOL_PURPLE = "\x1b[38;5;135m";  // #9945FF — Solana purple
const SOL_TEAL   = "\x1b[38;5;45m";   // #00D1FF — Solana blue
const SOL_LIME   = "\x1b[38;5;118m";  // bright lime accent
const WHT        = "\x1b[38;5;255m";  // white
const RED        = "\x1b[38;5;196m";  // red for errors/losses
const GRN        = "\x1b[38;5;46m";   // bright green for wins
const GOLD       = "\x1b[38;5;220m";  // gold for values
const ORANGE     = "\x1b[38;5;208m";  // orange
const CYN        = "\x1b[38;5;51m";   // cyan
const PINK       = "\x1b[38;5;213m";  // pink

// Backgrounds
const BGGRN      = "\x1b[48;5;22m";   // dark green bg
const BGRED      = "\x1b[48;5;52m";   // dark red bg
const BGPURP     = "\x1b[48;5;54m";   // dark purple bg
const BGTEAL     = "\x1b[48;5;24m";   // dark teal bg

// Solana gradient: green -> teal -> purple
const GRAD = [
  "\x1b[38;5;49m",  "\x1b[38;5;48m",  "\x1b[38;5;47m",
  "\x1b[38;5;43m",  "\x1b[38;5;44m",  "\x1b[38;5;45m",
  "\x1b[38;5;39m",  "\x1b[38;5;33m",  "\x1b[38;5;99m",
  "\x1b[38;5;135m", "\x1b[38;5;134m", "\x1b[38;5;133m",
];

// Section colors
const SECTIONS = [
  { bg: BGTEAL,  fg: SOL_TEAL,   emoji: "\u{1f3e0}" }, // House Stats
  { bg: BGPURP,  fg: SOL_PURPLE, emoji: "\u{1f3b2}" }, // VRF Games
  { bg: BGTEAL,  fg: SOL_GREEN,  emoji: "\u{1f9e0}" }, // Memory Slots
  { bg: BGRED,   fg: ORANGE,     emoji: "\u{1f3af}" }, // Hitman Market
  { bg: BGGRN,   fg: SOL_LIME,   emoji: "\u{1f4ca}" }, // Agent Stats
];

// ── Helpers ─────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function gradientText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ci = Math.floor((i / text.length) * GRAD.length);
    out += GRAD[Math.min(ci, GRAD.length - 1)] + B + text[i];
  }
  return out + R;
}

function banner(sectionIndex: number, title: string) {
  const s = SECTIONS[sectionIndex];
  const bar = `${s.fg}${"━".repeat(60)}${R}`;
  console.log("");
  console.log(bar);
  console.log(`  ${s.bg}${B}${WHT}  ${s.emoji}  ${R} ${s.fg}${B}${title}${R}`);
  console.log(bar);
  console.log("");
}

function statLine(label: string, value: string, color = GOLD) {
  const padLabel = label.padEnd(14);
  console.log(`  ${DIM}${padLabel}${R} ${color}${B}${value}${R}`);
}

function resultLine(won: boolean, game: string, detail: string) {
  const bg = won ? BGGRN : BGRED;
  const fg = won ? GRN : RED;
  const tag = won ? " WIN " : " LOSS";
  console.log(`  ${bg}${B}${WHT} ${tag} ${R} ${fg}${B}${game}${R}  ${DIM}${detail}${R}`);
}

// ── VRF Game Player ─────────────────────────────────────────────────

async function vrfPlayGame(
  sbProgram: anchor.Program,
  program: anchor.Program,
  provider: anchor.AnchorProvider,
  housePda: PublicKey,
  keypair: anchor.web3.Keypair,
  gameType: "coinflip" | "dice" | "limbo" | "crash",
  amountSol: number,
  param: any,
): Promise<{ won: boolean; payout: number; result: number; tx: string }> {
  const rngKeypair = anchor.web3.Keypair.generate();
  const [rngAccount, createIx] = await sb.Randomness.create(
    sbProgram as any, rngKeypair, sb.ON_DEMAND_DEVNET_QUEUE, keypair.publicKey);
  await provider.sendAndConfirm(new Transaction().add(createIx), [keypair, rngKeypair]);

  const houseAccount = await program.account.house.fetch(housePda);
  const amount = new anchor.BN(amountSol * LAMPORTS_PER_SOL);
  let seedPrefix: string;
  let requestMethod: string;
  let settleMethod: string;
  let requestArgs: any[];

  switch (gameType) {
    case "coinflip":
      seedPrefix = "vrf_request";
      requestMethod = "vrfCoinFlipRequest";
      settleMethod = "vrfCoinFlipSettle";
      requestArgs = [amount, param === "heads" ? 0 : 1];
      break;
    case "dice":
      seedPrefix = "vrf_dice";
      requestMethod = "vrfDiceRollRequest";
      settleMethod = "vrfDiceRollSettle";
      requestArgs = [amount, param];
      break;
    case "limbo":
      seedPrefix = "vrf_limbo";
      requestMethod = "vrfLimboRequest";
      settleMethod = "vrfLimboSettle";
      requestArgs = [amount, Math.floor(param * 100)];
      break;
    case "crash":
      seedPrefix = "vrf_crash";
      requestMethod = "vrfCrashRequest";
      settleMethod = "vrfCrashSettle";
      requestArgs = [amount, Math.floor(param * 100)];
      break;
  }

  const [vrfRequestPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(seedPrefix), keypair.publicKey.toBuffer(),
     (houseAccount as any).totalGames.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID);

  await (program.methods as any)[requestMethod](...requestArgs)
    .accounts({
      house: housePda,
      vrfRequest: vrfRequestPda,
      randomnessAccount: rngAccount.pubkey,
      player: keypair.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).rpc();

  const commitIx = await rngAccount.commitIx(sb.ON_DEMAND_DEVNET_QUEUE, keypair.publicKey);
  await provider.sendAndConfirm(new Transaction().add(commitIx), [keypair]);

  const [agentStatsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), keypair.publicKey.toBuffer()], PROGRAM_ID);

  const settleIx = await (program.methods as any)[settleMethod]()
    .accounts({
      house: housePda,
      vrfRequest: vrfRequestPda,
      agentStats: agentStatsPda,
      randomnessAccount: rngAccount.pubkey,
      player: keypair.publicKey,
      settler: keypair.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).instruction();

  // Wait for oracle, then reveal+settle in same TX
  // Mute ALL output during VRF (Switchboard SDK dumps full error stack traces)
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  console.log = () => {}; console.error = () => {}; console.warn = () => {};
  process.stdout.write = (() => true) as any;
  process.stderr.write = (() => true) as any;

  let tx = "";
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    try {
      const revealPromise = rngAccount.revealIx(keypair.publicKey);
      revealPromise.catch(() => {});
      const revealIx = await Promise.race([
        revealPromise,
        sleep(10000).then(() => { throw new Error("revealIx timeout"); }),
      ]);
      const combinedTx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 75000 }))
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }))
        .add(revealIx)
        .add(settleIx);
      tx = await provider.sendAndConfirm(combinedTx, [keypair]);
      break;
    } catch (e: any) {
      if (i === 19) {
        console.log = origLog; console.error = origErr; console.warn = origWarn;
        process.stdout.write = origStdoutWrite; process.stderr.write = origStderrWrite;
        throw new Error(`VRF oracle unavailable after 20 retries`);
      }
    }
  }

  // Wait for dangling Switchboard SDK error logs to fire while muted
  await sleep(2000);
  console.log = origLog; console.error = origErr; console.warn = origWarn;
  process.stdout.write = origStdoutWrite; process.stderr.write = origStderrWrite;

  const settled = await program.account.vrfRequest.fetch(vrfRequestPda);
  const payout = (settled as any).payout.toNumber() / LAMPORTS_PER_SOL;
  return { won: payout > 0, payout, result: (settled as any).result, tx };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  // ── Intro Header ──
  console.log("");
  console.log(gradientText("  ╔══════════════════════════════════════════════════╗"));
  console.log(gradientText("  ║     A G E N T   C A S I N O   P R O T O C O L   ║"));
  console.log(gradientText("  ║         Full Feature Demo — Solana Devnet        ║"));
  console.log(gradientText("  ╚══════════════════════════════════════════════════╝"));
  console.log("");
  statLine("Program ID:", "5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV", SOL_GREEN);
  statLine("Network:", "Solana Devnet", SOL_TEAL);
  statLine("VRF:", "Switchboard On-Demand", SOL_PURPLE);
  statLine("Source:", "github.com/Romulus-Sol/agent-casino", WHT);

  // ── Setup ──
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const origConsoleLog = console.log;
  console.log = () => {};
  const { keypair, address } = loadWallet();
  console.log = origConsoleLog;
  const casino = new AgentCasino(connection, keypair);
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const sbIdl = await anchor.Program.fetchIdl(sb.ON_DEMAND_DEVNET_PID, provider);
  if (!sbIdl) throw new Error("Could not fetch Switchboard IDL");
  const sbProgram = new anchor.Program(sbIdl, provider);

  const idlPath = path.join(__dirname, "../target/idl/agent_casino.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider) as any;

  const [housePda] = PublicKey.findProgramAddressSync([Buffer.from("house")], PROGRAM_ID);

  // ═══════════════════════════════════════════════════════════════════
  // ACT 1: HOUSE STATS
  // ═══════════════════════════════════════════════════════════════════
  banner(0, "ACT 1: House Stats");

  const balance = await connection.getBalance(keypair.publicKey);
  const house = await casino.getHouseStats();

  statLine("Wallet:", address, SOL_GREEN);
  statLine("Balance:", `${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`, GOLD);
  console.log("");
  statLine("Pool:", `${house.pool.toFixed(4)} SOL`, SOL_TEAL);
  statLine("House Edge:", `${house.houseEdgeBps / 100}%`, WHT);
  statLine("Min Bet:", `${house.minBet} SOL`, WHT);
  statLine("Total Games:", `${house.totalGames}`, GOLD);
  statLine("Volume:", `${house.totalVolume.toFixed(4)} SOL`, GOLD);
  statLine("Payout:", `${house.totalPayout.toFixed(4)} SOL`, GOLD);
  statLine("Profit:", `${house.houseProfit.toFixed(4)} SOL`, SOL_GREEN);

  // ═══════════════════════════════════════════════════════════════════
  // ACT 2: VRF GAMES
  // ═══════════════════════════════════════════════════════════════════
  banner(1, "ACT 2: VRF Games (Switchboard Randomness)");
  console.log(`  ${DIM}Each game: create VRF account -> request -> oracle commit -> reveal+settle${R}`);
  console.log(`  ${DIM}All randomness is on-chain and verifiable.${R}\n`);

  const betSize = 0.001;
  let totalWon = 0;
  let totalLost = 0;

  // Game 1: Coin Flip
  const coinChoice = Math.random() < 0.5 ? "heads" : "tails";
  process.stdout.write(`  ${SOL_GREEN}${B}[1/4]${R} ${WHT}Coin Flip${R} ${DIM}— ${coinChoice} @ ${betSize} SOL ...${R} `);
  try {
    const r = await vrfPlayGame(sbProgram, program, provider, housePda, keypair, "coinflip", betSize, coinChoice);
    if (r.won) {
      totalWon++;
      console.log(`${GRN}${B}WIN${R} ${GRN}+${r.payout.toFixed(4)} SOL${R}  ${DIM}tx: ${r.tx}${R}`);
    } else {
      totalLost++;
      console.log(`${RED}${B}LOSS${R} ${RED}-${betSize} SOL${R}  ${DIM}tx: ${r.tx}${R}`);
    }
  } catch (e: any) {
    console.log(`${ORANGE}${B}ERROR:${R} ${DIM}${e.message.slice(0, 55)}${R}`);
  }

  await sleep(3000);

  // Game 2: Dice Roll
  const diceTarget = Math.floor(Math.random() * 3) + 1;
  process.stdout.write(`  ${SOL_TEAL}${B}[2/4]${R} ${WHT}Dice Roll${R} ${DIM}— target <=${diceTarget} @ ${betSize} SOL ...${R} `);
  try {
    const r = await vrfPlayGame(sbProgram, program, provider, housePda, keypair, "dice", betSize, diceTarget);
    if (r.won) {
      totalWon++;
      console.log(`${GRN}${B}WIN${R} ${GRN}+${r.payout.toFixed(4)} SOL${R}  ${DIM}tx: ${r.tx}${R}`);
    } else {
      totalLost++;
      console.log(`${RED}${B}LOSS${R} ${RED}-${betSize} SOL${R}  ${DIM}tx: ${r.tx}${R}`);
    }
  } catch (e: any) {
    console.log(`${ORANGE}${B}ERROR:${R} ${DIM}${e.message.slice(0, 55)}${R}`);
  }

  await sleep(3000);

  // Game 3: Limbo
  const limboMult = +(1.5 + Math.random() * 1.5).toFixed(2);
  process.stdout.write(`  ${SOL_PURPLE}${B}[3/4]${R} ${WHT}Limbo${R} ${DIM}— target ${limboMult}x @ ${betSize} SOL ...${R} `);
  try {
    const r = await vrfPlayGame(sbProgram, program, provider, housePda, keypair, "limbo", betSize, limboMult);
    if (r.won) {
      totalWon++;
      console.log(`${GRN}${B}WIN${R} ${GRN}+${r.payout.toFixed(4)} SOL${R}  ${DIM}tx: ${r.tx}${R}`);
    } else {
      totalLost++;
      console.log(`${RED}${B}LOSS${R} ${RED}-${betSize} SOL${R}  ${DIM}tx: ${r.tx}${R}`);
    }
  } catch (e: any) {
    console.log(`${ORANGE}${B}ERROR:${R} ${DIM}${e.message.slice(0, 55)}${R}`);
  }

  await sleep(3000);

  // Game 4: Crash
  const crashMult = +(1.2 + Math.random() * 0.8).toFixed(2);
  process.stdout.write(`  ${PINK}${B}[4/4]${R} ${WHT}Crash${R} ${DIM}— cashout ${crashMult}x @ ${betSize} SOL ...${R} `);
  try {
    const r = await vrfPlayGame(sbProgram, program, provider, housePda, keypair, "crash", betSize, crashMult);
    if (r.won) {
      totalWon++;
      console.log(`${GRN}${B}WIN${R} ${GRN}+${r.payout.toFixed(4)} SOL${R}  ${DIM}tx: ${r.tx}${R}`);
    } else {
      totalLost++;
      console.log(`${RED}${B}LOSS${R} ${RED}-${betSize} SOL${R}  ${DIM}tx: ${r.tx}${R}`);
    }
  } catch (e: any) {
    console.log(`${ORANGE}${B}ERROR:${R} ${DIM}${e.message.slice(0, 55)}${R}`);
  }

  console.log(`\n  ${DIM}Result:${R} ${GOLD}${B}${totalWon}W / ${totalLost}L${R}`);

  // ═══════════════════════════════════════════════════════════════════
  // ACT 3: MEMORY SLOTS
  // ═══════════════════════════════════════════════════════════════════
  banner(2, "ACT 3: Memory Slots (Knowledge Marketplace)");

  try {
    const [memoryPoolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("memory_pool")], PROGRAM_ID);
    const pool = await program.account.memoryPool.fetch(memoryPoolPda);

    statLine("Pool:", memoryPoolPda.toString(), SOL_GREEN);
    statLine("Pull Price:", `${pool.pullPrice.toNumber() / LAMPORTS_PER_SOL} SOL`, GOLD);
    statLine("Stake Amount:", `${pool.stakeAmount.toNumber() / LAMPORTS_PER_SOL} SOL`, GOLD);
    statLine("Memories:", pool.totalMemories.toString(), SOL_TEAL);
    statLine("Total Pulls:", pool.totalPulls.toString(), SOL_TEAL);
    statLine("Pool Balance:", `${pool.poolBalance.toNumber() / LAMPORTS_PER_SOL} SOL`, GOLD);

    const totalMem = pool.totalMemories.toNumber();
    if (totalMem > 0) {
      console.log(`\n  ${SOL_GREEN}${B}Recent Memories${R}`);
      console.log(`  ${DIM}${"─".repeat(56)}${R}`);
      const start = Math.max(0, totalMem - 3);
      for (let i = totalMem - 1; i >= start; i--) {
        try {
          const [memPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("memory"), memoryPoolPda.toBuffer(), new anchor.BN(i).toArrayLike(Buffer, "le", 8)],
            PROGRAM_ID);
          const mem = await program.account.memory.fetch(memPda);
          const content = Buffer.from(mem.content.slice(0, mem.contentLength)).toString("utf8");
          const cat = Object.keys(mem.category)[0];
          const rar = Object.keys(mem.rarity)[0];
          const rarColor = rar === "legendary" ? GOLD : rar === "rare" ? SOL_PURPLE : WHT;
          console.log(`  ${DIM}[${i}]${R} ${rarColor}${B}${cat}/${rar}${R} ${DIM}— "${content.substring(0, 45)}${content.length > 45 ? "..." : ""}"${R}`);
        } catch { /* skip */ }
      }
    }
  } catch (e: any) {
    console.log(`  ${DIM}Memory pool not found: ${e.message.slice(0, 60)}${R}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // ACT 4: HITMAN MARKET
  // ═══════════════════════════════════════════════════════════════════
  banner(3, "ACT 4: Hitman Market (On-Chain Bounties)");

  try {
    const [hitPoolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("hit_pool")], PROGRAM_ID);
    const hitPool = await program.account.hitPool.fetch(hitPoolPda);

    statLine("Total Hits:", hitPool.totalHits.toString(), ORANGE);
    statLine("Completed:", hitPool.totalCompleted.toString(), SOL_GREEN);
    statLine("Bounties Paid:", `${hitPool.totalBountiesPaid.toNumber() / LAMPORTS_PER_SOL} SOL`, GOLD);
    statLine("House Edge:", `${hitPool.houseEdgeBps / 100}%`, WHT);

    const totalHits = hitPool.totalHits.toNumber();
    if (totalHits > 0) {
      console.log(`\n  ${ORANGE}${B}Recent Bounties${R}`);
      console.log(`  ${DIM}${"─".repeat(56)}${R}`);
      const start = Math.max(0, totalHits - 3);
      for (let i = totalHits - 1; i >= start; i--) {
        try {
          const buf = Buffer.alloc(8);
          buf.writeBigUInt64LE(BigInt(i));
          const [hitPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("hit"), hitPoolPda.toBuffer(), buf], PROGRAM_ID);
          const hit = await program.account.hit.fetch(hitPda);
          const status = Object.keys(hit.status)[0].toUpperCase();
          const statusColor = status === "OPEN" ? SOL_GREEN : status === "COMPLETED" ? GOLD : DIM;
          console.log(`  ${DIM}[${i}]${R} ${statusColor}${B}${status}${R} ${DIM}— "${hit.condition.substring(0, 40)}${hit.condition.length > 40 ? "..." : ""}"${R} ${GOLD}${B}${hit.bounty.toNumber() / LAMPORTS_PER_SOL} SOL${R}`);
        } catch { /* skip */ }
      }
    }
  } catch (e: any) {
    console.log(`  ${DIM}Hit pool not found: ${e.message.slice(0, 60)}${R}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // ACT 5: AGENT STATS
  // ═══════════════════════════════════════════════════════════════════
  banner(4, "ACT 5: Agent Stats (On-Chain Leaderboard)");

  try {
    const stats = await casino.getMyStats();
    statLine("Total Games:", `${stats.totalGames}`, GOLD);
    statLine("Wagered:", `${stats.totalWagered.toFixed(4)} SOL`, GOLD);
    statLine("Won:", `${stats.totalWon.toFixed(4)} SOL`, SOL_GREEN);
    statLine("Win Rate:", `${stats.winRate.toFixed(1)}%`, stats.winRate >= 50 ? SOL_GREEN : RED);
    statLine("PvP Games:", `${stats.pvpGames || 0}`, SOL_TEAL);
    statLine("PvP Wins:", `${stats.pvpWins || 0}`, SOL_TEAL);
  } catch {
    console.log(`  ${DIM}No agent stats found for this wallet.${R}`);
  }

  // Updated house stats
  const updatedHouse = await casino.getHouseStats();
  console.log(`\n  ${SOL_TEAL}${B}Updated House Stats${R}`);
  console.log(`  ${DIM}${"─".repeat(56)}${R}`);
  const gamesDelta = updatedHouse.totalGames - house.totalGames;
  console.log(`  ${DIM}Games:${R} ${GOLD}${B}${house.totalGames}${R} ${DIM}->${R} ${SOL_GREEN}${B}${updatedHouse.totalGames}${R} ${DIM}(+${gamesDelta})${R}`);
  console.log(`  ${DIM}Pool:${R}  ${GOLD}${B}${house.pool.toFixed(4)}${R} ${DIM}->${R} ${SOL_GREEN}${B}${updatedHouse.pool.toFixed(4)} SOL${R}`);

  // ═══════════════════════════════════════════════════════════════════
  // OUTRO
  // ═══════════════════════════════════════════════════════════════════
  console.log("");
  console.log(gradientText("  ══════════════════════════════════════════════════"));
  console.log(gradientText("                   Demo Complete                    "));
  console.log(gradientText("  ══════════════════════════════════════════════════"));
  console.log("");
  statLine("Program:", "5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV", SOL_GREEN);
  statLine("Source:", "github.com/Romulus-Sol/agent-casino", WHT);
  statLine("SDK:", "npm install @agent-casino/sdk", SOL_TEAL);
  statLine("Docs:", "skill.md / FEATURES.md", SOL_PURPLE);
  console.log("");
  console.log(`  ${SOL_GREEN}${B}12 security audits${R} ${DIM}|${R} ${GOLD}${B}175 found${R} ${DIM}|${R} ${SOL_GREEN}${B}151 fixed${R} ${DIM}|${R} ${SOL_PURPLE}${B}VRF-only randomness${R}`);
  console.log(`  ${DIM}${IT}Built by Claude for the Colosseum Agent Hackathon 2026${R}\n`);
}

main().catch((err) => {
  console.error(`${RED}${B}Fatal:${R} ${err.message}`);
  process.exit(1);
});
