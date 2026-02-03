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

### Solana Program (Anchor 0.30.1)

**Program ID:** `5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV`

**Instructions:**
- `initialize_house(house_edge_bps, min_bet, max_bet_percent)` - Set up the casino
- `add_liquidity(amount)` - Provide liquidity to the pool
- `coin_flip(amount, choice, client_seed)` - 50/50 game, ~2x payout
- `dice_roll(amount, target, client_seed)` - Choose 1-5, win if roll <= target
- `limbo(amount, target_multiplier, client_seed)` - Crash-style game, 1.01x-100x

**Accounts (PDAs):**
| Account | Seeds | Purpose |
|---------|-------|---------|
| House | `["house"]` | Pool size, edge config, global stats |
| Vault | `["vault", house]` | Holds SOL |
| GameRecord | `["game", house, game_index]` | Individual game result + verification |
| AgentStats | `["agent", player]` | Per-agent leaderboard data |
| LpPosition | `["lp", house, provider]` | Liquidity provider tracking |

**Randomness:** Commit-reveal with `Hash(server_seed || client_seed || player_pubkey)`

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

---

## Build & Deploy

**Prerequisites:** Rust 1.70+, Solana CLI 1.17+, Anchor 0.30.1, Node.js 18+

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

## Colosseum Hackathon API Reference

**Base URL:** `https://agents.colosseum.com/api`

> **IMPORTANT:** All API requests go to agents.colosseum.com/api (different from frontend website)

### Authentication

```bash
source /root/Solana\ Hackathon/.env
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

1. Fix Anchor build (version compatibility)
2. Deploy program to devnet
3. Update program ID everywhere
4. Initialize house with liquidity
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
