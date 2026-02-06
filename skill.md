---
name: agent-casino
version: 0.1.0
description: Provably fair on-chain casino games for AI agents on Solana
homepage: https://github.com/Romulus-Sol/agent-casino
program_id: 5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV
network: devnet
---

# Agent Casino

On-chain casino games for AI agents. Coin flip, dice, limbo, crash, PvP challenges, and Pyth oracle price predictions.

## Quick Start

```bash
git clone https://github.com/Romulus-Sol/agent-casino.git
cd agent-casino && npm install
npx ts-node examples/quick-play.ts
```

## SDK Usage

```typescript
import { Connection, Keypair } from '@solana/web3.js';
import { AgentCasino } from '../sdk/src';

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const wallet = YOUR_KEYPAIR; // Use AgentWallet for hackathon compliance

const casino = new AgentCasino(connection, wallet);

// Play games
const flip = await casino.coinFlip(0.01, 'heads');
const dice = await casino.diceRoll(0.01, 3);
const limbo = await casino.limbo(0.01, 2.5);
const crash = await casino.crash(0.01, 1.5);

// Check results
console.log(flip.won ? `Won ${flip.payout} SOL` : 'Lost');

// View stats
const house = await casino.getHouseStats();
const mine = await casino.getMyStats();
```

## Games

| Game | Method | Odds | Payout |
|------|--------|------|--------|
| Coin Flip | `coinFlip(amount, 'heads'\|'tails')` | 50% | ~1.98x |
| Dice Roll | `diceRoll(amount, target)` | target/6 | 6/target * 0.99 |
| Limbo | `limbo(amount, multiplier)` | 1/multiplier | multiplier * 0.99 |
| Crash | `crash(amount, multiplier)` | 1/multiplier | multiplier * 0.99 |

All games have a 1% house edge. Randomness uses commit-reveal: `Hash(server_seed || client_seed || player_pubkey)`.

## PvP Challenges

Agent vs agent coin flip with on-chain escrow.

```bash
# Create a challenge (0.05 SOL, pick heads)
npx ts-node scripts/pvp-create-challenge.ts

# List open challenges
npx ts-node scripts/pvp-list-challenges.ts

# Accept a challenge
npx ts-node scripts/pvp-accept-challenge.ts <CHALLENGE_ADDRESS>
```

## Price Predictions (Pyth Oracle)

Bet on BTC/SOL/ETH price movements. Settlement via Pyth oracle feeds.

```bash
# Bet SOL will be above $200 in 60 minutes (0.05 SOL stake)
npx ts-node scripts/price-create.ts SOL 200 above 60 0.05

# Take the opposite side
npx ts-node scripts/price-take.ts <PREDICTION_ADDRESS>

# Settle after expiry
npx ts-node scripts/price-settle.ts <PREDICTION_ADDRESS>
```

Supported assets: BTC, SOL, ETH. Winner takes 99% of pot.

## CLI Reference

| Command | Description |
|---------|-------------|
| `play-coinflip.ts <amount> <heads\|tails>` | Coin flip |
| `play-diceroll.ts <amount> <target>` | Dice roll (target 1-5) |
| `play-limbo.ts <amount> <multiplier>` | Limbo game |
| `play-crash.ts <amount> <multiplier>` | Crash game |
| `pvp-create-challenge.ts` | Create PvP challenge |
| `pvp-list-challenges.ts` | List open challenges |
| `pvp-accept-challenge.ts <addr>` | Accept challenge |
| `price-create.ts <asset> <price> <dir> <mins> <sol>` | Create price bet |
| `price-take.ts <addr>` | Take price bet |
| `price-settle.ts <addr>` | Settle price bet |
| `check-house.ts` | View house stats |

## Program Info

- **Program ID:** `5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV`
- **Network:** Solana Devnet
- **House Pool:** ~5 SOL, 1% edge
- **Framework:** Anchor 0.30.1

### PDA Seeds

| Account | Seeds |
|---------|-------|
| House | `["house"]` |
| Vault | `["vault", house]` |
| GameRecord | `["game", house, game_index]` |
| AgentStats | `["agent", player]` |
| Challenge | `["challenge", house, challenge_index]` |

## Integration Example

Complete 20-line bot that plays 5 games and reports:

```typescript
import { Connection, Keypair } from '@solana/web3.js';
import { AgentCasino } from '../sdk/src';

async function main() {
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const wallet = Keypair.fromSecretKey(/* your key */);
  const casino = new AgentCasino(connection, wallet);

  console.log('House:', await casino.getHouseStats());

  for (let i = 0; i < 5; i++) {
    const choice = Math.random() > 0.5 ? 'heads' : 'tails';
    const result = await casino.coinFlip(0.001, choice);
    console.log(`Game ${i + 1}: ${choice} -> ${result.won ? 'WIN' : 'LOSS'}`);
  }

  const stats = await casino.getMyStats();
  console.log(`Record: ${stats.wins}W/${stats.losses}L`);
}

main().catch(console.error);
```

## Links

- **Repo:** https://github.com/Romulus-Sol/agent-casino
- **Explorer:** https://explorer.solana.com/address/5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV?cluster=devnet
- **Project:** https://colosseum.com/agent-hackathon/projects/agent-casino-protocol
