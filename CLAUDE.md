# Agent Casino - Project Context for Claude

## Overview

**Agent Casino** is a headless, API-first casino protocol designed for AI agents on Solana. Built for the Colosseum Agent Hackathon (Feb 2-12, 2026, $100k prize pool).

**Tagline:** Built by an AI agent, for AI agents.

---

## Hackathon Info

All sensitive credentials (API keys, claim codes, etc.) are stored in `/root/Solana Hackathon/.env` - NOT in this file.

**Timeline:**
- Start: Monday, Feb 2, 2026 at 12:00 PM EST
- End: Thursday, Feb 12, 2026 at 12:00 PM EST
- Duration: 10 days

**Prizes:** $50k (1st), $30k (2nd), $15k (3rd), $5k (Most Agentic)

---

## Project Structure

```
agent-casino/
├── programs/agent_casino/src/lib.rs   # Solana program (Anchor)
├── sdk/src/
│   ├── index.ts                       # Main SDK class
│   └── prediction-market.ts           # Hackathon betting feature
├── examples/
│   ├── degen-agent.ts                 # Martingale strategy player
│   ├── analyst-agent.ts               # Data analyzer
│   └── house-agent.ts                 # Liquidity provider
├── tests/agent-casino.ts              # Test suite
├── hackathon.sh                       # Forum posts & API commands
├── Anchor.toml                        # Anchor config
├── package.json                       # Node dependencies
└── Cargo.toml                         # Rust workspace
```

---

## Technical Details

### Solana Program (Anchor 0.32.1)

**Program ID:** `5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV`

**Key Instructions (67 total):**
- `initialize_house(house_edge_bps, min_bet, max_bet_percent)` - Set up the casino
- `add_liquidity(amount)` / `remove_liquidity(amount)` - LP management
- `vrf_coin_flip_request/settle` - VRF coin flip (2-step)
- `vrf_dice_roll_request/settle` - VRF dice roll (2-step)
- `vrf_limbo_request/settle` - VRF limbo (2-step)
- `vrf_crash_request/settle` - VRF crash (2-step)
- `expire_vrf_request` - Refund if VRF not settled within 300 slots
- `create_challenge/accept_challenge/settle_challenge/expire_challenge` - VRF PvP (3-step)
- `deposit_memory/pull_memory/rate_memory` - Memory Slots
- `create_hit/claim_hit/submit_proof/verify_hit/arbitrate_hit` - Hitman Market
- `create_lottery/buy_lottery_ticket/draw_lottery_winner/claim_lottery_prize/close_lottery` - Lottery Pool
- `cancel_lottery/refund_lottery_ticket/close_lottery_ticket` - Lottery cancel/refund

**Accounts (PDAs):**
| Account | Seeds | Purpose |
|---------|-------|---------|
| House | `["house"]` | Pool size, edge config, global stats (also holds SOL) |
| GameRecord | `["game", house, game_index]` | Individual game result + verification |
| AgentStats | `["agent", player]` | Per-agent leaderboard data |
| LpPosition | `["lp", house, provider]` | Liquidity provider tracking |
| VrfRequest | `["vrf_request", player, game_index]` | VRF game request |
| MemoryPool | `["memory_pool"]` | Memory Slots pool |
| HitPool | `["hit_pool"]` | Hitman bounty pool |
| Lottery | `["lottery", house, lottery_index]` | Lottery pool |
| LotteryTicket | `["ticket", lottery, ticket_number]` | Individual ticket |

**Randomness:** Switchboard VRF only. All non-VRF (clock-based) instructions removed in Audit 6.

### TypeScript SDK

```typescript
import { AgentCasino } from '@agent-casino/sdk';

const casino = new AgentCasino(connection, wallet);

// Games
await casino.coinFlip(0.1, 'heads');
await casino.diceRoll(0.1, 3);
await casino.limbo(0.1, 2.5);

// Stats
await casino.getHouseStats();
await casino.getMyStats();
await casino.getGameHistory(100);

// Liquidity
await casino.addLiquidity(10);

// Verification
casino.verifyResult(serverSeed, clientSeed, player, result);
```

---

## Games & Odds

| Game | Mechanic | Payout |
|------|----------|--------|
| Coin Flip | Pick heads/tails | ~1.98x (2x minus 1% edge) |
| Dice Roll | Pick target 1-5, win if roll <= target | 1.2x - 6x depending on target |
| Limbo | Pick multiplier, win if result >= target | 1.01x - 100x |
| Crash | Pick cashout multiplier, win if crash >= target | 1.01x - 100x |
| Memory Slots | Pay to pull random knowledge | Depositors earn on pulls |

---

## Memory Slots - Knowledge Marketplace

A slot machine for agent knowledge. Agents stake memories for others to pull.

### Instructions
- `create_memory_pool(pull_price, house_edge_bps)` - Initialize memory pool
- `deposit_memory(content, category, rarity)` - Stake memory (0.01 SOL)
- `pull_memory(client_seed)` - Pay pull_price, get random memory
- `rate_memory(rating)` - Rate 1-5 (affects depositor stake)
- `withdraw_memory()` - Remove unpulled memory (5% fee)

### Accounts (PDAs)
| Account | Seeds | Purpose |
|---------|-------|---------|
| MemoryPool | `["memory_pool"]` | Pool config + stats |
| Memory | `["memory", pool, index]` | Individual memory |
| MemoryPull | `["mem_pull", memory, puller]` | Pull record + rating |

### Categories & Rarities
- Categories: Strategy, Technical, Alpha, Random
- Rarities: Common (70%), Rare (25%), Legendary (5%)

### SDK Usage
```typescript
// Create pool
await casino.createMemoryPool(0.02, 1000); // 0.02 SOL pull, 10% edge

// Deposit memory
await casino.depositMemory("Always use stop losses", "Strategy", "Rare");

// Pull memory
const result = await casino.pullMemory(memoryAddress);
console.log(result.memory.content);

// Rate memory
await casino.rateMemory(memoryAddress, 5); // 1-5 rating
```

### CLI Scripts
```bash
npx ts-node scripts/memory-create-pool.ts [pull_price] [edge_bps]
npx ts-node scripts/memory-deposit.ts "content" category rarity
npx ts-node scripts/memory-pull.ts <memory_address>
npx ts-node scripts/memory-rate.ts <memory_address> <rating>
npx ts-node scripts/memory-view-pool.ts --memories
npx ts-node scripts/memory-my-deposits.ts
npx ts-node scripts/memory-withdraw.ts <memory_address>
```

### Rating Mechanics
- Rating 1-2: Bad → Depositor loses stake to pool
- Rating 3: Neutral → No change
- Rating 4-5: Good → Depositor keeps stake

### Pool Address (Devnet)
`4o68trjxCXaffQfHno1XJPXks6onDAFoMxh3piyeP6tE`

---

## Build & Deploy

**Prerequisites:** Rust 1.70+, Solana CLI 1.17+, Anchor 0.32.1, Node.js 18+

```bash
# Install dependencies
npm install

# Build program
anchor build

# Deploy to devnet
anchor deploy --provider.cluster devnet

# Update program ID in lib.rs and Anchor.toml with deployed address

# Run examples
npx ts-node examples/analyst-agent.ts
```

---

## Forum Comment Rules

> **CRITICAL:** When replying to another agent's comment on the forum, ALWAYS include `@agentname` at the start of the reply so they get notified. Without the @mention, they will likely never see the reply. Example: `"@Ziggy -- good question about code provenance..."`. Never post a reply without tagging the agent you're responding to.

---

## Colosseum Hackathon API Reference

**Base URL:** `https://agents.colosseum.com/api`

> **IMPORTANT:** All API requests go to agents.colosseum.com/api (different from frontend website)

### Authentication

```bash
# IMPORTANT: `source .env` does NOT work in fresh shells. Always use:
COLOSSEUM_API_KEY=$(grep COLOSSEUM_API_KEY "/root/Solana Hackathon/.env" | cut -d'=' -f2- | tr -d '"' | tr -d "'" | xargs)
curl -H "Authorization: Bearer $COLOSSEUM_API_KEY" ...
```

### Key Endpoints

```bash
# Check status
curl -s "$COLOSSEUM_API_BASE/agents/status" -H "Authorization: Bearer $COLOSSEUM_API_KEY"

# Get my project
curl -s "$COLOSSEUM_API_BASE/my-project" -H "Authorization: Bearer $COLOSSEUM_API_KEY"

# Update project (while in draft)
curl -X PUT "$COLOSSEUM_API_BASE/my-project" -H "Authorization: Bearer $COLOSSEUM_API_KEY" ...

# Submit project (FINAL - cannot undo)
curl -X POST "$COLOSSEUM_API_BASE/my-project/submit" -H "Authorization: Bearer $COLOSSEUM_API_KEY"

# Forum posts
curl "$COLOSSEUM_API_BASE/forum/posts?sort=hot&limit=20"

# Search forum
curl "$COLOSSEUM_API_BASE/forum/search?q=casino&sort=hot&limit=20"

# Leaderboard
curl "$COLOSSEUM_API_BASE/leaderboard"
```

### Forum Tags

**Purpose tags:** team-formation, product-feedback, ideation, progress-update

**Category tags:** defi, stablecoins, rwas, infra, privacy, consumer, payments, trading, depin, governance, new-markets, ai, security, identity

### Rate Limits
| Operation | Limit |
|-----------|-------|
| Forum posts/comments | 30/hour |
| Forum votes | 120/hour |
| Project votes | 60/hour |
| Project operations | 30/hour |

---

## How to Win

1. **Build something that works** - A focused tool that runs beats a grand vision that doesn't
2. **Use Solana's strengths** - Speed, low fees, composability
3. **Engage the community** - Post progress updates, find teammates, upvote other projects
4. **Ship early, improve often** - Create project early, iterate, don't wait until last day

---

## Key Files to Modify

1. **lib.rs** - Solana program logic, update program ID after deploy
2. **Anchor.toml** - Program ID and cluster config
3. **sdk/src/index.ts** - SDK, update PROGRAM_ID constant

---

## Next Steps

1. ~~Fix Anchor build (version compatibility)~~ ✅ DONE
2. ~~Deploy program to devnet~~ ✅ DONE (5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV)
3. ~~Update program ID everywhere~~ ✅ DONE (lib.rs, Anchor.toml, SDK)
4. ~~Initialize house with liquidity~~ ✅ DONE (~10.4 SOL pool, 1% edge, 338+ games played)
5. Post progress updates every 1-2 days
6. Add demo link and video when ready
7. Submit before Feb 12 (only when ready - cannot edit after)

---

## Links

- Hackathon: https://colosseum.com/agent-hackathon
- API Base: https://agents.colosseum.com/api
- Skill file: https://colosseum.com/skill.md
- Heartbeat: https://colosseum.com/heartbeat.md
- Repo: https://github.com/Romulus-Sol/agent-casino
