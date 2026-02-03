/**
 * Agent Casino - Live Demo Showcase
 * A theatrical demo script for screen recording.
 */

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { randomBytes } from "crypto";

const PROGRAM_ID = new PublicKey("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

// Terminal colors
const R = "\x1b[0m";    // Reset
const B = "\x1b[1m";    // Bright
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GRN = "\x1b[32m";
const YEL = "\x1b[33m";
const BLU = "\x1b[34m";
const MAG = "\x1b[35m";
const CYN = "\x1b[36m";
const BGGRN = "\x1b[42m";
const BGRED = "\x1b[41m";
const WHT = "\x1b[37m";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sol = (lamports: number | bigint) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(4);

function printHeader() {
  console.log(`
${CYN}${B}
  ╔═══════════════════════════════════════════════════════════════════╗
  ║                                                                   ║
  ║      █████╗  ██████╗ ███████╗███╗   ██╗████████╗                  ║
  ║     ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝                  ║
  ║     ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║                     ║
  ║     ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║                     ║
  ║     ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║                     ║
  ║     ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝                     ║
  ║                                                                   ║
  ║      ██████╗ █████╗ ███████╗██╗███╗   ██╗ ██████╗                 ║
  ║     ██╔════╝██╔══██╗██╔════╝██║████╗  ██║██╔═══██╗                ║
  ║     ██║     ███████║███████╗██║██╔██╗ ██║██║   ██║                ║
  ║     ██║     ██╔══██║╚════██║██║██║╚██╗██║██║   ██║                ║
  ║     ╚██████╗██║  ██║███████║██║██║ ╚████║╚██████╔╝                ║
  ║      ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═══╝ ╚═════╝                 ║
  ║                                                                   ║
  ║                  🎰  L I V E   D E M O  🎰                        ║
  ║                                                                   ║
  ║            Built by an AI Agent, for AI Agents                    ║
  ║                 Solana Devnet • Provably Fair                     ║
  ║                                                                   ║
  ╚═══════════════════════════════════════════════════════════════════╝
${R}
`);
}

function section(title: string, emoji: string) {
  console.log(`
${YEL}${B}════════════════════════════════════════════════════════════════════
${emoji}  ${title}
════════════════════════════════════════════════════════════════════${R}
`);
}

function subHeader(text: string) {
  console.log(`${MAG}${B}▸ ${text}${R}`);
}

function showWin(payout: number) {
  console.log(`${BGGRN}${B}${WHT}  🎉 WIN! Payout: ${sol(payout)} SOL  ${R}`);
}

function showLoss() {
  console.log(`${BGRED}${B}${WHT}  ❌ LOSS  ${R}`);
}

async function getHouseStats(provider: anchor.AnchorProvider, housePda: PublicKey) {
  const acc = await provider.connection.getAccountInfo(housePda);
  if (!acc) throw new Error("House not initialized");
  const d = acc.data;
  let o = 8;
  const authority = new PublicKey(d.slice(o, o + 32)); o += 32;
  const pool = d.readBigUInt64LE(o); o += 8;
  const houseEdgeBps = d.readUInt16LE(o); o += 2;
  const minBet = d.readBigUInt64LE(o); o += 8;
  const maxBetPercent = d[o]; o += 1;
  const totalGames = d.readBigUInt64LE(o); o += 8;
  const totalVolume = d.readBigUInt64LE(o); o += 8;
  const totalPayout = d.readBigUInt64LE(o);
  return { authority, pool, houseEdgeBps, minBet, maxBetPercent, totalGames, totalVolume, totalPayout };
}

async function getAgentStats(provider: anchor.AnchorProvider, pda: PublicKey) {
  try {
    const acc = await provider.connection.getAccountInfo(pda);
    if (!acc) return null;
    const d = acc.data;
    let o = 8;
    const agent = new PublicKey(d.slice(o, o + 32)); o += 32;
    const totalGames = d.readBigUInt64LE(o); o += 8;
    const totalWagered = d.readBigUInt64LE(o); o += 8;
    const totalWon = d.readBigUInt64LE(o); o += 8;
    const wins = d.readBigUInt64LE(o); o += 8;
    const losses = d.readBigUInt64LE(o);
    return { agent, totalGames, totalWagered, totalWon, wins, losses };
  } catch { return null; }
}

async function playGame(
  provider: anchor.AnchorProvider,
  gameType: "coinFlip" | "diceRoll" | "limbo",
  amount: number,
  choice: number,
  housePda: PublicKey,
  vaultPda: PublicKey
) {
  const house = await getHouseStats(provider, housePda);
  const gameIndex = house.totalGames;

  const [gameRecordPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), housePda.toBuffer(), Buffer.from(new anchor.BN(gameIndex).toArray("le", 8))],
    PROGRAM_ID
  );
  const [agentStatsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), provider.wallet.publicKey.toBuffer()],
    PROGRAM_ID
  );

  const clientSeed = randomBytes(32);
  const amountLamports = Math.floor(amount * LAMPORTS_PER_SOL);

  // Discriminators from IDL
  const disc: Record<string, number[]> = {
    coinFlip: [229, 124, 31, 2, 166, 139, 34, 248],
    diceRoll: [234, 73, 108, 215, 140, 60, 156, 90],
    limbo: [160, 191, 152, 136, 103, 207, 214, 159],
  };

  let data: Buffer;
  if (gameType === "limbo") {
    data = Buffer.concat([
      Buffer.from(disc[gameType]),
      new anchor.BN(amountLamports).toArrayLike(Buffer, "le", 8),
      Buffer.from(new Uint16Array([choice]).buffer),
      clientSeed,
    ]);
  } else {
    data = Buffer.concat([
      Buffer.from(disc[gameType]),
      new anchor.BN(amountLamports).toArrayLike(Buffer, "le", 8),
      Buffer.from([choice]),
      clientSeed,
    ]);
  }

  const ix = new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: housePda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: gameRecordPda, isSigner: false, isWritable: true },
      { pubkey: agentStatsPda, isSigner: false, isWritable: true },
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new anchor.web3.Transaction().add(ix);
  const sig = await provider.sendAndConfirm(tx);

  await sleep(500);
  const rec = await provider.connection.getAccountInfo(gameRecordPda);
  if (!rec) throw new Error("Game record not found");

  const rd = rec.data;
  let o = 8 + 32 + 1;
  o += 8; // amount
  const recChoice = rd[o]; o += 1;
  const result = rd[o]; o += 1;
  const payout = rd.readBigUInt64LE(o); o += 8;
  const serverSeed = rd.slice(o, o + 32);

  return {
    signature: sig,
    choice: recChoice,
    result,
    payout: Number(payout),
    won: Number(payout) > 0,
    serverSeed: Buffer.from(serverSeed).toString("hex").slice(0, 16) + "...",
    clientSeed: clientSeed.toString("hex").slice(0, 16) + "...",
  };
}

async function main() {
  console.clear();
  printHeader();
  await sleep(2000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const [housePda] = PublicKey.findProgramAddressSync([Buffer.from("house")], PROGRAM_ID);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), housePda.toBuffer()], PROGRAM_ID);
  const [agentStatsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), provider.wallet.publicKey.toBuffer()], PROGRAM_ID
  );

  // ═══════════════════════════════════════════════════════════════
  // HOUSE STATS
  // ═══════════════════════════════════════════════════════════════
  section("HOUSE STATUS", "🏛️");

  const initHouse = await getHouseStats(provider, housePda);

  console.log(`${CYN}┌─────────────────────────────────────────────┐${R}`);
  console.log(`${CYN}│${R}  ${B}House PDA:${R}     ${housePda.toString().slice(0, 22)}...`);
  console.log(`${CYN}│${R}  ${B}Pool Size:${R}     ${GRN}${sol(initHouse.pool)} SOL${R}`);
  console.log(`${CYN}│${R}  ${B}House Edge:${R}    ${(initHouse.houseEdgeBps / 100).toFixed(2)}%`);
  console.log(`${CYN}│${R}  ${B}Min Bet:${R}       ${sol(initHouse.minBet)} SOL`);
  console.log(`${CYN}│${R}  ${B}Max Bet:${R}       ${initHouse.maxBetPercent}% of pool`);
  console.log(`${CYN}│${R}  ${B}Total Games:${R}   ${initHouse.totalGames.toString()}`);
  console.log(`${CYN}│${R}  ${B}Volume:${R}        ${sol(initHouse.totalVolume)} SOL`);
  console.log(`${CYN}└─────────────────────────────────────────────┘${R}`);

  await sleep(3000);

  // ═══════════════════════════════════════════════════════════════
  // COIN FLIP
  // ═══════════════════════════════════════════════════════════════
  section("COIN FLIP", "🪙");
  console.log(`${DIM}50/50 odds • ~2x payout • Pick heads or tails${R}\n`);
  await sleep(1500);

  subHeader("Flip #1: Betting 0.002 SOL on HEADS");
  console.log(`${DIM}Flipping coin...${R}`);
  await sleep(1500);

  try {
    const f1 = await playGame(provider, "coinFlip", 0.002, 0, housePda, vaultPda);
    console.log(`   Choice: ${YEL}HEADS (0)${R}`);
    console.log(`   Result: ${f1.result === 0 ? GRN + "HEADS ✓" : RED + "TAILS ✗"}${R}`);
    f1.won ? showWin(f1.payout) : showLoss();
    console.log(`   ${DIM}Server Seed: ${f1.serverSeed}${R}`);
    console.log(`   ${DIM}Client Seed: ${f1.clientSeed}${R}`);
    console.log(`   ${DIM}Tx: ${f1.signature.slice(0, 32)}...${R}`);
  } catch (e: any) { console.log(`   ${RED}Error: ${e.message}${R}`); }

  await sleep(2500);

  subHeader("Flip #2: Betting 0.002 SOL on TAILS");
  console.log(`${DIM}Flipping coin...${R}`);
  await sleep(1500);

  try {
    const f2 = await playGame(provider, "coinFlip", 0.002, 1, housePda, vaultPda);
    console.log(`   Choice: ${YEL}TAILS (1)${R}`);
    console.log(`   Result: ${f2.result === 1 ? GRN + "TAILS ✓" : RED + "HEADS ✗"}${R}`);
    f2.won ? showWin(f2.payout) : showLoss();
    console.log(`   ${DIM}Tx: ${f2.signature.slice(0, 32)}...${R}`);
  } catch (e: any) { console.log(`   ${RED}Error: ${e.message}${R}`); }

  await sleep(2500);

  // ═══════════════════════════════════════════════════════════════
  // DICE ROLL
  // ═══════════════════════════════════════════════════════════════
  section("DICE ROLL", "🎲");
  console.log(`${DIM}Pick target 1-5 • Win if roll ≤ target • Lower target = higher payout${R}\n`);
  await sleep(1500);

  subHeader("Roll #1: RISKY - Target ≤2 (33% chance, ~3x payout)");
  console.log(`${DIM}Rolling dice...${R}`);
  await sleep(1500);

  try {
    const r1 = await playGame(provider, "diceRoll", 0.002, 2, housePda, vaultPda);
    console.log(`   Target: ${YEL}≤ 2${R}`);
    console.log(`   Roll:   ${r1.result <= 2 ? GRN : RED}${r1.result}${R}`);
    r1.won ? showWin(r1.payout) : showLoss();
    console.log(`   ${DIM}Tx: ${r1.signature.slice(0, 32)}...${R}`);
  } catch (e: any) { console.log(`   ${RED}Error: ${e.message}${R}`); }

  await sleep(2500);

  subHeader("Roll #2: SAFE - Target ≤5 (83% chance, ~1.2x payout)");
  console.log(`${DIM}Rolling dice...${R}`);
  await sleep(1500);

  try {
    const r2 = await playGame(provider, "diceRoll", 0.002, 5, housePda, vaultPda);
    console.log(`   Target: ${YEL}≤ 5${R}`);
    console.log(`   Roll:   ${r2.result <= 5 ? GRN : RED}${r2.result}${R}`);
    r2.won ? showWin(r2.payout) : showLoss();
    console.log(`   ${DIM}Tx: ${r2.signature.slice(0, 32)}...${R}`);
  } catch (e: any) { console.log(`   ${RED}Error: ${e.message}${R}`); }

  await sleep(2500);

  // ═══════════════════════════════════════════════════════════════
  // LIMBO
  // ═══════════════════════════════════════════════════════════════
  section("LIMBO", "🚀");
  console.log(`${DIM}Pick target multiplier 1.01x-100x • Win if result ≥ target${R}\n`);
  await sleep(1500);

  subHeader("Limbo #1: Target 2.00x multiplier (50% chance)");
  console.log(`${DIM}Calculating result...${R}`);
  await sleep(1500);

  try {
    const l1 = await playGame(provider, "limbo", 0.002, 200, housePda, vaultPda);
    console.log(`   Target:  ${YEL}2.00x${R}`);
    console.log(`   Result:  ${l1.won ? GRN + "≥ 2.00x ✓" : RED + "< 2.00x ✗"}${R}`);
    l1.won ? showWin(l1.payout) : showLoss();
    console.log(`   ${DIM}Tx: ${l1.signature.slice(0, 32)}...${R}`);
  } catch (e: any) { console.log(`   ${RED}Error: ${e.message}${R}`); }

  await sleep(2500);

  subHeader("Limbo #2: Target 5.00x multiplier (20% chance - RISKY!)");
  console.log(`${DIM}Calculating result...${R}`);
  await sleep(1500);

  try {
    const l2 = await playGame(provider, "limbo", 0.002, 500, housePda, vaultPda);
    console.log(`   Target:  ${YEL}5.00x${R}`);
    console.log(`   Result:  ${l2.won ? GRN + "≥ 5.00x ✓" : RED + "< 5.00x ✗"}${R}`);
    l2.won ? showWin(l2.payout) : showLoss();
    console.log(`   ${DIM}Tx: ${l2.signature.slice(0, 32)}...${R}`);
  } catch (e: any) { console.log(`   ${RED}Error: ${e.message}${R}`); }

  await sleep(2500);

  // ═══════════════════════════════════════════════════════════════
  // FINAL STATS
  // ═══════════════════════════════════════════════════════════════
  section("FINAL RESULTS", "📊");

  const finalHouse = await getHouseStats(provider, housePda);
  const finalAgent = await getAgentStats(provider, agentStatsPda);

  const gamesPlayed = Number(finalHouse.totalGames) - Number(initHouse.totalGames);
  const volumeAdded = Number(finalHouse.totalVolume) - Number(initHouse.totalVolume);
  const poolChange = Number(finalHouse.pool) - Number(initHouse.pool);

  console.log(`${CYN}┌──────────────────── HOUSE ────────────────────┐${R}`);
  console.log(`${CYN}│${R}  Games this session:   ${B}${gamesPlayed}${R}`);
  console.log(`${CYN}│${R}  Volume this session:  ${B}${sol(volumeAdded)} SOL${R}`);
  console.log(`${CYN}│${R}  Pool change:          ${poolChange >= 0 ? GRN + "+" : RED}${sol(poolChange)} SOL${R}`);
  console.log(`${CYN}│${R}  Total games (all):    ${B}${finalHouse.totalGames.toString()}${R}`);
  console.log(`${CYN}│${R}  Total volume (all):   ${B}${sol(finalHouse.totalVolume)} SOL${R}`);
  console.log(`${CYN}└────────────────────────────────────────────────┘${R}`);

  if (finalAgent) {
    const winRate = Number(finalAgent.totalGames) > 0
      ? (Number(finalAgent.wins) / Number(finalAgent.totalGames) * 100).toFixed(1) : "0.0";
    const profit = Number(finalAgent.totalWon) - Number(finalAgent.totalWagered);
    const roi = Number(finalAgent.totalWagered) > 0
      ? (profit / Number(finalAgent.totalWagered) * 100).toFixed(1) : "0.0";

    console.log(`\n${MAG}┌──────────────────── AGENT ────────────────────┐${R}`);
    console.log(`${MAG}│${R}  Wallet:         ${provider.wallet.publicKey.toString().slice(0, 22)}...`);
    console.log(`${MAG}│${R}  Total Games:    ${B}${finalAgent.totalGames.toString()}${R}`);
    console.log(`${MAG}│${R}  Wins/Losses:    ${GRN}${finalAgent.wins.toString()} W${R} / ${RED}${finalAgent.losses.toString()} L${R}`);
    console.log(`${MAG}│${R}  Win Rate:       ${B}${winRate}%${R}`);
    console.log(`${MAG}│${R}  Total Wagered:  ${sol(finalAgent.totalWagered)} SOL`);
    console.log(`${MAG}│${R}  Total Won:      ${sol(finalAgent.totalWon)} SOL`);
    console.log(`${MAG}│${R}  Profit/Loss:    ${profit >= 0 ? GRN + "+" : RED}${sol(profit)} SOL${R}`);
    console.log(`${MAG}│${R}  ROI:            ${profit >= 0 ? GRN : RED}${roi}%${R}`);
    console.log(`${MAG}└────────────────────────────────────────────────┘${R}`);
  }

  console.log(`
${CYN}${B}
  ══════════════════════════════════════════════════════════════════

                   🎰 AGENT CASINO - DEMO COMPLETE 🎰

            All games are provably fair with on-chain verification
                   Built by an AI agent, for AI agents

                Program: ${PROGRAM_ID.toString().slice(0, 24)}...
                Network: Solana Devnet

  ══════════════════════════════════════════════════════════════════
${R}
`);
}

main().catch((err) => {
  console.error(`${RED}Error: ${err.message}${R}`);
  process.exit(1);
});
