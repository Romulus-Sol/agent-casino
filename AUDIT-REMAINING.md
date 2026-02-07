# Remaining Audit Issues — Full Report

**Date:** February 6, 2026
**Program:** Agent Casino Protocol (`5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV`)
**File:** `programs/agent_casino/src/lib.rs`

**STATUS: ALL 5 ISSUES FIXED** — Deployed February 6, 2026. See commit history for changes.

---

## 1. `init_if_needed` Re-initialization Risk — 12 instances (CRITICAL)

`init_if_needed` means if the PDA account already exists, Anchor skips initialization and proceeds. But if someone manages to close/drain the account, the next call re-creates it from scratch — resetting all state to zero.

For **AgentStats**, this means an agent's entire win/loss history, total wagered, and leaderboard position could be wiped. There are 9 instances for AgentStats alone:

| Context | Line | Account |
|---------|------|---------|
| PlayGame (all 4 games) | ~3108 | `agent_stats` |
| AcceptChallenge | ~3183 | `challenger_stats` |
| AcceptChallenge | ~3192 | `acceptor_stats` |
| ClaimPredictionWinnings | ~3351 | `agent_stats` |
| TokenCoinFlip | ~3856 | `agent_stats` |
| VrfCoinFlipSettle | ~3912 | `agent_stats` |
| VrfDiceRollSettle | ~3970 | `agent_stats` |
| VrfLimboSettle | ~4028 | `agent_stats` |
| VrfCrashSettle | ~4086 | `agent_stats` |

Plus 3 non-stats accounts:

| Context | Line | Account |
|---------|------|---------|
| AddLiquidity | ~3072 | `lp_position` (LP could reset deposit history) |
| TokenAddLiquidity | ~3808 | `token_lp_position` |
| ArbitrateHit | ~3730 | `arbitration` (arbiter could reset votes) |

### Fix

Split into two patterns:
- First-time: separate `init_agent_stats` instruction with `#[account(init, ...)]`
- Subsequent: use `#[account(mut, seeds = [...], bump)]` — fails if account doesn't exist yet, which is correct

### Breaking Change

Yes — requires a new `init_agent_stats` instruction and all existing contexts must change from `init_if_needed` to `mut`. Existing accounts are unaffected but the SDK flow changes (must call init before first game).

---

## 2. Missing `close` Constraints — 10 account types (HIGH)

Every PDA created with `init` pays rent (~0.002 SOL per account). These accounts are never closeable, so rent is permanently locked. Over thousands of games, this adds up.

| Account | Created Per | Est. Rent | Can Close? |
|---------|-------------|-----------|------------|
| GameRecord | Every game | 0.002 SOL | No |
| VrfRequest (x4 types) | Every VRF game | 0.002 SOL | No |
| Challenge | Every PvP match | 0.002 SOL | No |
| PricePrediction | Every price bet | 0.002 SOL | No |
| PredictionBet | Every market bet | 0.002 SOL | No |
| TokenGameRecord | Every token game | 0.002 SOL | No |
| Memory | Every deposit | 0.002 SOL | No (withdraw exists but doesn't close) |
| MemoryPull | Every pull | 0.002 SOL | No |
| Hit | Every bounty | 0.002 SOL | No |

At 85+ games already played, that's ~0.17 SOL locked in uncloseable GameRecords alone.

### Fix

Add `close` instructions for settled/completed accounts:

```rust
// Example: close a settled game record
pub fn close_game_record(ctx: Context<CloseGameRecord>) -> Result<()> {
    Ok(()) // Anchor handles the close via the constraint
}

#[derive(Accounts)]
pub struct CloseGameRecord<'info> {
    #[account(
        mut,
        close = recipient,
        seeds = [b"game", house.key().as_ref(), &game_record.game_index.to_le_bytes()],
        bump,
    )]
    pub game_record: Account<'info, GameRecord>,
    pub house: Account<'info, House>,
    /// CHECK: Rent recipient
    #[account(mut)]
    pub recipient: AccountInfo<'info>,
    #[account(constraint = authority.key() == house.authority @ CasinoError::NotAuthority)]
    pub authority: Signer<'info>,
}
```

### Breaking Change

No — additive only (new instructions). Existing accounts and flows are unaffected. Safest of all fixes to ship.

---

## 3. Weak Commitment Scheme — Custom Hash (MEDIUM-HIGH)

The randomness uses a custom `mix_bytes()` function instead of a cryptographic hash.

### Current Code (~line 2983)

```rust
fn mix_bytes(data: &[u8]) -> [u8; 32] {
    let mut result = [0u8; 32];
    for (i, byte) in data.iter().enumerate() {
        let idx = i % 32;
        result[idx] = result[idx].wrapping_add(*byte);
        result[(idx + 1) % 32] = result[(idx + 1) % 32].wrapping_mul(result[idx].wrapping_add(1));
        result[(idx + 7) % 32] ^= byte.wrapping_add(i as u8);
    }
    // 4 additional mixing rounds
    for round in 0..4 {
        for i in 0..32 {
            result[i] = result[i].wrapping_add(result[(i + round + 1) % 32]);
            result[(i + 13) % 32] ^= result[i].rotate_left(3);
        }
    }
    result
}
```

### Problems

1. **Not a cryptographic hash** — No proven avalanche effect, no preimage resistance guarantees. Custom XOR/ADD mixing is not a substitute for SHA-256 or Keccak.
2. **Server seed uses slot + timestamp** (~line 2973) — Both are known before transaction execution, making the "server seed" predictable by validators.
3. **No separation of commitment** — Server and client seeds are combined in the same transaction, so the server (house) sees the client seed before the outcome is determined.

### Fix

Replace `mix_bytes` with `solana_program::hash::hash()` (SHA-256):

```rust
use solana_program::hash::hash;

fn combine_seeds(server: &[u8; 32], client: &[u8; 32], player: Pubkey) -> [u8; 32] {
    let combined = [server.as_ref(), client.as_ref(), player.to_bytes().as_ref()].concat();
    hash(&combined).to_bytes()
}
```

For server seed entropy, use the previous blockhash instead of slot/timestamp.

### Mitigation

Switchboard VRF is now available for all 4 games, which completely sidesteps this issue for agents that opt in. The commit-reveal path remains for speed-sensitive use cases but should be upgraded to use proper cryptographic hashing.

### Breaking Change

Yes — changes game outcomes for the same seed inputs. Existing game records would verify differently against new logic. Would need to version the verification so old games verify against old hash and new games verify against SHA-256.

---

## 4. Floating-Point Arithmetic — 2 functions, 6 uses (CRITICAL)

Two game functions use `f64` for payout calculations. Floating-point is non-deterministic across CPU architectures. Different validators could compute different results for the same inputs, breaking consensus.

### `calculate_limbo_result()` (~line 2999)

```rust
fn calculate_limbo_result(raw: u32, house_edge_bps: u16) -> u16 {
    let max = u32::MAX as f64;                                       // f64 cast
    let normalized = raw as f64 / max;                               // f64 division
    let edge_factor = 1.0 - (house_edge_bps as f64 / 10000.0);      // f64 division
    let result = (edge_factor / (1.0 - normalized * 0.99)) * 100.0;  // f64 arithmetic
    (result.min(10000.0) as u16).max(100)
}
```

### `calculate_crash_point()` (~line 3011)

```rust
fn calculate_crash_point(raw: u32, house_edge_bps: u16) -> u16 {
    let max = u32::MAX as f64;                                       // f64 cast
    let normalized = raw as f64 / max;                               // f64 division
    let edge_factor = 1.0 - (house_edge_bps as f64 / 10000.0);      // f64 division
    let divisor = 1.0 - (normalized * 0.99);
    let crash_multiplier = if divisor > 0.001 {
        (99.0 * edge_factor / divisor)
    } else { 10000.0 };
    (crash_multiplier.min(10000.0) as u16).max(100)
}
```

### Why This Is Bad

- Floating-point is non-deterministic across CPU architectures
- Different validators could compute different results for the same inputs
- In practice, Solana BPF VMs likely produce consistent results, but it's an explicit anti-pattern that auditors and judges will flag
- Financial calculations should never use floats

### Fix — Fixed-Point Integer Math

```rust
fn calculate_limbo_result(raw: u32, house_edge_bps: u16) -> u16 {
    // All math in u128, scaled by 10000 (BPS)
    let normalized_bps = (raw as u128 * 9900) / (u32::MAX as u128);  // 0-9900
    let denominator = 10000u128.saturating_sub(normalized_bps);       // avoid div-by-zero
    if denominator == 0 { return 10000; }
    let edge_factor = 10000u128 - house_edge_bps as u128;            // e.g. 9900 for 1% edge
    let result = (edge_factor * 100) / denominator;                   // multiplier * 100
    (result.min(10000) as u16).max(100)
}

fn calculate_crash_point(raw: u32, house_edge_bps: u16) -> u16 {
    let normalized_bps = (raw as u128 * 9900) / (u32::MAX as u128);
    let denominator = 10000u128.saturating_sub(normalized_bps);
    if denominator < 10 { return 10000; } // cap at 100x
    let edge_factor = 10000u128 - house_edge_bps as u128;
    let result = (edge_factor * 99) / denominator;
    (result.min(10000) as u16).max(100)
}
```

### Breaking Change

Yes — changes game outcomes for the same raw inputs. The distribution shape stays the same but exact values may differ at the margins. Same versioning concern as issue #3.

---

## 5. Remaining `unwrap()` in Constraints — 2 instances (MEDIUM)

Two account constraints still use `unwrap()`:

| Line | Context | Code |
|------|---------|------|
| ~3644 | VerifyHit | `constraint = hunter.key() == hit.hunter.unwrap() @ CasinoError::NotTheHunter` |
| ~3742 | ArbitrateHit | `constraint = hunter.key() == hit.hunter.unwrap() @ CasinoError::NotTheHunter` |

Both have a preceding `constraint = hit.hunter.is_some()` guard, so they won't panic in practice. But if the constraint ordering ever changes during refactoring, the `unwrap()` would cause a program panic instead of a clean error.

### Fix

Combine into a single safe constraint:

```rust
constraint = hit.hunter.map_or(false, |h| hunter.key() == h) @ CasinoError::NotTheHunter
```

### Breaking Change

No — behavior is identical, just safer. Can fix in-place.

---

## Summary

| # | Issue | Severity | Instances | Breaking Change? |
|---|-------|----------|-----------|-----------------|
| 1 | `init_if_needed` re-init | CRITICAL | 12 | Yes — new init instruction + context changes |
| 2 | Missing `close` constraints | HIGH | 10 account types | No — additive only (new instructions) |
| 3 | Custom hash (not SHA-256) | MEDIUM-HIGH | 2 functions | Yes — changes game outcomes |
| 4 | Floating-point arithmetic | CRITICAL | 2 functions | Yes — changes game outcomes |
| 5 | `unwrap()` in constraints | MEDIUM | 2 | No — safe to fix in-place |

### Implementation Priority

1. **Issue 5** (unwrap) — Zero risk, fix immediately
2. **Issue 2** (close constraints) — Additive only, no breaking changes, recovers rent
3. **Issue 1** (init_if_needed) — Requires SDK flow change but critical for security
4. **Issue 4** (floating-point) — Critical for audit scoring but changes outcomes
5. **Issue 3** (custom hash) — Mitigated by VRF availability, lowest priority

### Mitigating Factors

- **VRF availability** — Issues 3 and 4 only affect the commit-reveal path. Agents using VRF get cryptographically secure randomness with no floating-point in the outcome calculation.
- **Devnet only** — No real funds at risk. These would be mandatory fixes before any mainnet deployment.
- **PDA security** — `init_if_needed` requires the account to be closed first, which requires the program to have a close instruction (which it doesn't — see issue 2). So ironically, issue 2 being unfixed makes issue 1 less exploitable.
