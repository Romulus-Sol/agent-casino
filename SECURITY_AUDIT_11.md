# Security Audit #11: Pre-Submission Mega Audit

**Date:** February 11, 2026 (Day 10)
**Scope:** Full program (`lib.rs`, ~5,500 lines), `cpi_helpers.rs`, SDK (`sdk/src/index.ts`), all scripts, documentation
**Method:** 4 parallel audit agents (on-chain security, tests & deployment, SDK & docs, git & repo health) + systematic fix pass
**Previous audits:** 10 completed, 157 findings (135 fixed, 9 won't fix, 13 by design)

---

## Summary

| Severity | Found | Fixed |
|----------|-------|-------|
| HIGH | 1 | 1 |
| MEDIUM | 2 | 2 |
| LOW | 2 | 2 |
| INFO | 4 | 4 |
| **Total** | **9** | **9** |

**All findings fixed and deployed to devnet.** Two commits: `264a4d5` (clippy + SDK) and `8b0be30` (security fixes, deployed TX `367ARo8S...`).

---

## HIGH Findings

### H-1: PvP randomness_account in AcceptChallenge allows acceptor gaming
- **Context:** `AcceptChallenge` struct
- **Status:** FIXED (on-chain deployed)
- **Impact:** Acceptor controls which Switchboard VRF account is used for settlement. By pre-computing or selecting a favorable randomness account, the acceptor can guarantee winning the PvP challenge.
- **Fix:** Moved `randomness_account` from `AcceptChallenge` to `CreateChallenge` context. The challenger now commits to a specific Switchboard randomness account at creation time, before any acceptor is known. Updated SDK `createChallenge()` to require `randomnessAccount` parameter, `acceptChallenge()` no longer takes it. Updated all PvP scripts.

---

## MEDIUM Findings

### M-1: LP withdrawal restricted to house authority only
- **Context:** `RemoveLiquidity` struct, `provider` field
- **Status:** FIXED (on-chain deployed)
- **Impact:** Only the house authority could withdraw liquidity, locking all other LP providers' funds.
- **Description:** `RemoveLiquidity` had `constraint = provider.key() == house.authority` on the `provider` field. This prevented any LP who deposited liquidity via `add_liquidity` from ever withdrawing.
- **Fix:** Removed the authority constraint. Any signer with an LP position can now withdraw their own funds. The LP position PDA (`["lp", house, provider]`) ensures providers can only access their own position.

### M-2: SDK `createPredictionMarket` and `revealPredictionBet` instruction arg mismatch
- **Status:** FIXED (SDK)
- **Impact:** Both SDK methods would fail at runtime due to extra arguments not matching the on-chain instruction.
- **Description:** `createPredictionMarket` passed an extra `outcomes` parameter, and `revealPredictionBet` passed an extra `new BN(0)` argument. Both would cause Anchor deserialization errors.
- **Fix:** Removed the extra arguments from both methods.

---

## LOW Findings

### L-1: VRF settle instructions missing pool liquidity check at settlement time
- **Context:** `vrf_coin_flip_settle`, `vrf_dice_roll_settle`, `vrf_limbo_settle`, `vrf_crash_settle`
- **Status:** FIXED (on-chain deployed)
- **Impact:** If the house pool was drained between VRF request and settlement (by other winning bets), the settle instruction would panic with an arithmetic underflow when transferring the payout.
- **Fix:** Added `require!(house_lamports >= payout, CasinoError::InsufficientLiquidity)` check before lamport transfer in all 4 VRF settle instructions. On insufficient liquidity, the transaction fails gracefully and the player can use `expire_vrf_request` after 300 slots for a full refund.

### L-2: `Arbitration.hit` field never set in `arbitrate_hit`
- **Context:** `arbitrate_hit` function
- **Status:** FIXED (on-chain deployed)
- **Impact:** The `arbitration.hit` field was always `Pubkey::default()` (all zeros), making it impossible to look up which hit an arbitration record belongs to by reading the account data.
- **Fix:** Added `arbitration.hit = ctx.accounts.hit.key();` in the `arbitrate_hit` function.

---

## INFO Findings

### I-1: 23 Clippy warnings (code quality)
- **Status:** FIXED
- **Description:** `cargo clippy -D warnings` flagged 23 code quality issues across `lib.rs`:
  - `realloc()` → `resize()` (deprecated API)
  - `checked_sub().unwrap_or(0)` → `saturating_sub()` (3 instances)
  - `randomness: randomness,` → `randomness,` (4 instances, redundant field names)
  - Unnecessary `as u8` casts (2 instances)
  - `len() > 0` → `!is_empty()` (4 instances)
  - Manual range checks → `.contains()` (6 instances)
  - `map_or(false, ...)` → `is_some_and(...)` (2 instances)
- **Fix:** All 23 issues resolved. `cargo clippy` now passes with 0 warnings.

### I-2: Dead CPI helper structs
- **File:** `cpi_helpers.rs`
- **Status:** FIXED
- **Description:** `CpiCoinFlip`, `CpiDiceRoll`, `CpiLimbo` structs referenced non-VRF instructions that were removed in Audit 6. Dead code that could mislead developers.
- **Fix:** Removed all 3 structs and outdated module-level doc example. Kept active CPI helpers: `CpiAddLiquidity`, `CpiCreateChallenge`, `CpiAcceptChallenge`, `CpiDepositMemory`, `CpiPullMemory`, and all PDA derivation functions.

### I-3: 8 unused error variants
- **Status:** FIXED
- **Description:** `BettingClosed`, `CannotChangeBetOutcome`, `NoWinningBets`, `TokenVaultNotInitialized`, `InvalidMint`, `TokenVaultMismatch`, `InsufficientTokenBalance`, `InvalidArbiter` — none referenced anywhere in the program.
- **Fix:** Removed all 8 variants. Verified `LotteryNotOpen` (initially flagged) is actually used at line 2670 and was kept.

### I-4: `#![allow(unexpected_cfgs)]` needed for Anchor macros
- **Status:** FIXED
- **Description:** Anchor 0.32.1 macros generate `cfg(feature = "anchor-deprecated-state")` and `cfg(feature = "idl-build")` attributes that produce 81 "unexpected_cfgs" warnings under newer Rust toolchains.
- **Fix:** Added `#![allow(unexpected_cfgs)]` at crate level.

---

## Cumulative Audit Totals

| Metric | Count |
|--------|-------|
| Total audits | 11 |
| Total findings | 166 |
| Fixed | 144 |
| Won't fix (documented) | 9 |
| By design | 13 |

## Deployment

Program deployed to devnet:
- **TX:** `367ARo8Sd6MAmLXwPq87NDJDJAcX8b4fa6cELveqoEcus4AozvgkiqUttdehkST9Jaz5MYWfp2QFh8jmuGBwy3oy`
- **Program ID:** `5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV`
- **Verification:** `anchor build` success, `cargo clippy` 0 warnings, 68 SDK tests passing
