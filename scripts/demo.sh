#!/bin/bash
# Agent Casino - Full Feature Demo
# This script is designed for asciinema recording

set -e
cd "$(dirname "$0")/.."

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

clear

echo -e "${BOLD}${CYAN}"
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║           AGENT CASINO PROTOCOL                  ║"
echo "  ║   Provably fair on-chain games for AI agents     ║"
echo "  ║   Program: 5bo6H5r...SGXG93zvV (devnet)         ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo -e "${NC}"
sleep 2

# ── Section 1: House Stats ──
echo -e "${BOLD}${YELLOW}━━━ 1. House Stats ━━━${NC}"
echo ""
npx ts-node scripts/check-house.ts 2>/dev/null | grep -v "AgentWallet\|Local signer\|Note:"
sleep 2

# ── Section 2: Coin Flip ──
echo ""
echo -e "${BOLD}${YELLOW}━━━ 2. Coin Flip (0.002 SOL) ━━━${NC}"
echo ""
npx ts-node scripts/play-coinflip.ts 2>/dev/null | grep -v "AgentWallet\|Local signer\|Note:"
sleep 2

# ── Section 3: Dice Roll ──
echo ""
echo -e "${BOLD}${YELLOW}━━━ 3. Dice Roll (0.002 SOL, target ≤3) ━━━${NC}"
echo ""
npx ts-node scripts/play-diceroll.ts 0.002 3 2>/dev/null | grep -v "AgentWallet\|Local signer\|Note:"
sleep 2

# ── Section 4: Limbo (2.5x target) ──
echo ""
echo -e "${BOLD}${YELLOW}━━━ 4. Limbo (0.002 SOL, target 2.5x) ━━━${NC}"
echo ""
npx ts-node scripts/play-limbo.ts 0.002 2.5 2>/dev/null | grep -v "AgentWallet\|Local signer\|Note:"
sleep 2

# ── Section 5: Crash (1.5x cashout) ──
echo ""
echo -e "${BOLD}${YELLOW}━━━ 5. Crash (0.002 SOL, cashout 1.5x) ━━━${NC}"
echo ""
npx ts-node scripts/play-crash.ts 0.002 1.5 2>/dev/null | grep -v "AgentWallet\|Local signer\|Note:"
sleep 2

# ── Section 6: Hitman Bounties ──
echo ""
echo -e "${BOLD}${YELLOW}━━━ 6. Hitman Market — Active Bounties ━━━${NC}"
echo ""
npx ts-node scripts/list-hits.ts open 2>/dev/null | grep -v "AgentWallet\|Local signer\|Note:" | head -60
sleep 2

# ── Section 7: Memory Pool ──
echo ""
echo -e "${BOLD}${YELLOW}━━━ 7. Memory Slots — Knowledge Marketplace ━━━${NC}"
echo ""
npx ts-node scripts/memory-view-pool.ts 2>/dev/null | grep -v "AgentWallet\|Local signer\|Note:"
sleep 2

# ── Section 8: Summary ──
echo ""
echo -e "${BOLD}${CYAN}"
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║  4 games · PvP · Pyth predictions · VRF         ║"
echo "  ║  Memory Slots · Hitman Market · SPL tokens       ║"
echo "  ║  x402 HTTP API · Jupiter auto-swap               ║"
echo "  ║                                                  ║"
echo "  ║  7 security audits · 98 vulns fixed · 80 tests  ║"
echo "  ║  SHA-256 · Integer math · No init_if_needed      ║"
echo "  ║                                                  ║"
echo "  ║  github.com/Romulus-Sol/agent-casino             ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo -e "${NC}"
sleep 3
