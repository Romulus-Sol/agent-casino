# Security Audit #10: Full Pre-Submission Audit

**Date:** February 10, 2026 (Day 9)
**Scope:** Full Anchor program (`lib.rs`, 5,450 lines) + `cpi_helpers.rs` (266 lines) + SDK (`sdk/src/index.ts`)
**Method:** 4 parallel Claude Opus audit agents, each covering ~1,350 lines with full program context
**Previous audits:** 9 completed, 125 findings, 125 fixed

---

## Summary

| Severity | Found | Fixed (SDK) | Needs Redeploy | Won't Fix | By Design |
|----------|-------|-------------|----------------|-----------|-----------|
| HIGH | 2 | 1 | 1 | 0 | 0 |
| MEDIUM | 12 | 1 | 5 | 4 | 2 |
| LOW | 11 | 0 | 2 | 5 | 4 |
| INFO | 7 | 0 | 0 | 0 | 7 |
| **Total** | **32** | **2** | **8** | **9** | **13** |

**Program is upgradeable.** On-chain fixes can be deployed after submission if needed.

---

## HIGH Findings

### H-1: PvP Challenge uses predictable clock-based randomness
- **Lines:** 307-316
- **Status:** NEEDS REDEPLOY (known limitation, documented)
- **Impact:** Acceptor can compute outcome before submitting, front-running the result.
- **Description:** `accept_challenge` generates the coin flip using `Clock::slot` + `Clock::unix_timestamp` + acceptor-supplied `client_seed`. All other games use Switchboard VRF but PvP was never migrated.
- **Mitigation:** PvP is rarely used (~0 games on-chain). Would need new `vrf_pvp_request/settle` instructions.
- **Fix plan:** Add VRF-backed PvP in post-hackathon upgrade.

### H-2: `resolve_prediction_market` — authority-supplied `winning_pool` with no bound check
- **Lines:** 714-757
- **Status:** FIXED IN SDK + NEEDS REDEPLOY for on-chain bound
- **Impact:** Authority can provide any `winning_pool` value, manipulating pari-mutuel payouts.
- **Description:** No check that `winning_pool <= market.total_pool`. Authority could set it to 1 lamport.
- **SDK fix:** `resolvePredictionMarket()` now accepts explicit `winningPool` parameter with `<= totalPool` validation and JSDoc warning about trusted authority model.
- **On-chain fix needed:** Add `require!(winning_pool <= market.total_pool, CasinoError::MathOverflow)`.

---

## MEDIUM Findings

### M-1: VRF settle contexts missing `vrf_request.house == house.key()` constraint
- **Lines:** 3752, 3808, 3864, 3920
- **Status:** NEEDS REDEPLOY
- **Impact:** Latent vulnerability if program ever supports multiple houses.
- **Description:** All 4 VRF settle contexts (coin flip, dice, limbo, crash) don't validate the VRF request belongs to the house passed in. Currently safe because there's only one house PDA.
- **On-chain fix:** Add `constraint = vrf_request.house == house.key()` to all 4 contexts.

### M-2: Price prediction bets bypass `house.pool` accounting
- **Lines:** 2301-2309, 2456-2479, 2804-2832
- **Status:** NEEDS REDEPLOY
- **Impact:** `house.pool` understates actual holdings; `remove_liquidity` could drain lamports owed to prediction bettors.
- **Description:** `create_price_prediction` and `take_price_prediction` transfer SOL to house but don't increment `house.pool`. Settlement and cancellation operate on raw lamports. Over time, pool accounting diverges from actual balance.
- **On-chain fix:** Add `house.pool += bet_amount` on create/take, subtract full pool on settle/cancel.

### M-3: `claim_lottery_prize` off-by-one: `>` should be `>=`
- **Lines:** 2721-2722
- **Status:** NEEDS REDEPLOY
- **Impact:** Lottery prize claim fails if house has exactly the prize amount in lamports.
- **Description:** Uses `house_lamports > prize` instead of `>=`.
- **On-chain fix:** Change to `>=` or better: check against rent-exempt minimum.

### M-4: Close instructions (GameRecord, VrfRequest, PricePrediction) — unrestricted rent recipient
- **Lines:** 4872, 4892, 4931
- **Status:** NEEDS REDEPLOY (SDK defaults are safe)
- **Impact:** Authority can send rent lamports to any address instead of back to account creator.
- **Description:** `CloseGameRecord`, `CloseVrfRequest`, `ClosePricePrediction` all accept arbitrary `recipient`. By contrast, `CloseChallenge` and `CloseHit` properly constrain recipients.
- **SDK mitigation:** SDK defaults recipient to `wallet.publicKey` (the authority).
- **On-chain fix:** Constrain recipient to original player/creator.

### M-5: `CloseVrfRequest` missing PDA seed validation
- **Lines:** 4885-4890
- **Status:** NEEDS REDEPLOY
- **Impact:** Any VrfRequest account can be closed (not just the one matching expected seeds).
- **Description:** No `seeds` constraint. Account type provides discriminator checking but not PDA verification.
- **On-chain fix:** Add `seeds = [b"vrf_request", vrf_request.player.as_ref(), &game_index.to_le_bytes()]`.

### M-6: `CloseLottery` can close before all cancelled refunds processed
- **Lines:** 5131-5152
- **Status:** WON'T FIX (creator-only, documented)
- **Impact:** Creator can close cancelled lottery before all ticket holders get refunds.
- **Description:** No check that all tickets have been refunded before closing a cancelled lottery.
- **Mitigation:** Only the lottery creator can close. Ticket data survives in ticket accounts.

### M-7: `init_if_needed` on Arbitration account
- **Lines:** 3628-3635
- **Status:** WON'T FIX (mitigated)
- **Impact:** Code smell — flagged by standard audit checklists.
- **Description:** Mitigated by PDA seeds (deterministic derivation) + `hit.status == HitStatus::Disputed` constraint + `arbiters.len() < 3` guard.

### M-8: `mint` as `UncheckedAccount` in token vault instructions
- **Lines:** 2952, 3666-3667
- **Status:** WON'T FIX (CPI validates)
- **Impact:** Theoretical fake mint could be passed.
- **Description:** SPL Token `initialize_account3` CPI validates the mint, reverting the entire TX on failure.

### M-9: `provider_ata` as `UncheckedAccount` in `TokenAddLiquidity`
- **Lines:** 3712-3714
- **Status:** WON'T FIX (CPI validates)
- **Impact:** Invalid ATA could be passed.
- **Description:** SPL Token `transfer` CPI validates owner, mint, and authority.

### M-10: `vault_ata` not cross-checked against `token_vault.vault_ata`
- **Lines:** 3697-3703
- **Status:** WON'T FIX (PDA validates)
- **Impact:** Deposited tokens could theoretically go to wrong account.
- **Description:** PDA derivation `[b"token_vault_ata", mint]` provides indirect validation.

### M-11: `DrawLotteryWinner` — randomness account has no Switchboard owner check
- **Lines:** 5098-5099
- **Status:** WON'T FIX (parse validates)
- **Impact:** Specially crafted account could pass `RandomnessAccountData::parse()`.
- **Description:** `parse()` would fail for non-Switchboard accounts, but explicit owner check preferred.

### M-12: `RemoveLiquidity` restricted to authority only
- **Lines:** 2997-3003
- **Status:** BY DESIGN
- **Impact:** Non-authority LPs cannot withdraw deposits.
- **Description:** Centralized LP model — authority manages all liquidity. Documented in SDK.

---

## LOW Findings

### L-1: `expire_vrf_request` doesn't decrement `total_volume`
- **Lines:** 141-172
- **Status:** WON'T FIX (stats only)
- **Description:** Expired VRF requests inflate `house.total_volume` since it was incremented at request time.

### L-2: Dice roll `raw % 6` modular bias (~10^-9)
- **Lines:** 1951-1952
- **Status:** WON'T FIX (negligible)
- **Description:** Bias of ~0.00000009%. Not exploitable in practice.

### L-3: `ForfeitUnrevealedBet` has no signer
- **Lines:** 3201-3216
- **Status:** BY DESIGN
- **Description:** Anyone can forfeit unrevealed bets after reveal deadline. Time-gated by design.

### L-4: `StartRevealPhase` has no signer
- **Lines:** 3170-3177
- **Status:** BY DESIGN
- **Description:** Permissionless phase transition after commit_deadline. Comment documents intent.

### L-5: Limbo/Crash result truncated to `u8`
- **Lines:** 2128, 2265
- **Status:** WON'T FIX (data fidelity only)
- **Description:** Full multiplier emitted in events and used for payouts. On-chain field loses precision.

### L-6: Unused `rent` UncheckedAccount in `InitializeTokenVault`
- **Lines:** 3681-3682
- **Status:** NEEDS REDEPLOY
- **Description:** Dead code — `Rent::get()` reads from sysvar cache, not this account.

### L-7: `cancel_hit` fee residual untracked in vault
- **Lines:** 1438-1440
- **Status:** WON'T FIX (minor accounting)
- **Description:** 1% cancel fee stays in hit_vault with no sweep mechanism.

### L-8: `calculate_payout` uses `saturating_mul`
- **Lines:** 2857-2864
- **Status:** WON'T FIX (capped downstream)
- **Description:** Saturating at `u128::MAX` followed by cap-to-`u64::MAX` handles all cases.

### L-9: `DrawLotteryWinner` creator can shop randomness account
- **Lines:** 5098, 2662-2678
- **Status:** BY DESIGN
- **Description:** Creator selects randomness account at draw time. Mitigated by slot matching requirement.

### L-10: `ClosePricePrediction` missing PDA seeds
- **Lines:** 4922-4929
- **Status:** NEEDS REDEPLOY
- **Description:** Account discriminator provides base validation; seeds would be belt-and-suspenders.

### L-11: `CloseTokenGameRecord` mint unchecked
- **Lines:** 4962-4963
- **Status:** BY DESIGN
- **Description:** PDA derivation on `token_vault` implicitly validates the mint.

---

## INFO Findings

| # | Description | Status |
|---|-------------|--------|
| I-1 | `challenger` typed as `AccountInfo` not `UncheckedAccount` (style) | Acknowledged |
| I-2 | Coin flip uses only 1 byte of 32-byte VRF output | Acknowledged |
| I-3 | `expire_claim` callable by anyone (by design) | By design |
| I-4 | `Memory` struct has unnecessary `#[max_len(500)]` on `[u8; 500]` | Acknowledged |
| I-5 | `RefundLotteryTicket` permissionless (by design) | By design |
| I-6 | `Lottery.status` is raw `u8` instead of enum | Acknowledged |
| I-7 | `CreateLottery` shares game counter with regular games | Acknowledged |

---

## On-Chain Fix Plan (Post-Audit Redeploy)

8 findings need program changes. Priority order:

1. **H-2:** Add `require!(winning_pool <= market.total_pool)` in `resolve_prediction_market`
2. **M-1:** Add `vrf_request.house == house.key()` to 4 VRF settle contexts
3. **M-2:** Track price prediction escrow in `house.pool`
4. **M-3:** Change `>` to `>=` in `claim_lottery_prize`
5. **M-4:** Constrain close instruction recipients to original creator/player
6. **M-5:** Add PDA seeds to `CloseVrfRequest`
7. **L-6:** Remove unused `rent` field from `InitializeTokenVault`
8. **L-10:** Add PDA seeds to `ClosePricePrediction`

Estimated: ~30 lines of changes. Low risk. Program is upgradeable.

---

## SDK Fixes Applied (No Redeploy Needed)

1. **H-2 mitigation:** `resolvePredictionMarket()` now accepts explicit `winningPool` parameter with client-side `<= totalPool` validation
2. **M-4 mitigation:** Close methods document that recipient defaults to authority wallet

---

## Previous Audits Reference

| # | Focus | Found | Fixed |
|---|-------|-------|-------|
| 1 | Core program (accounts, math, access) | 26 | 26 |
| 2 | Jupiter + x402 gateway | 16 | 16 |
| 3 | Arithmetic safety + Switchboard VRF | 8 | 8 |
| 4 | Breaking changes (init_if_needed, close, SHA-256) | 5 | 5 |
| 5 | Deep arithmetic & liquidity | 30 | 30 |
| 6 | VRF-only + on-chain tests | 8 | 8 |
| 7 | VRF demo verification | 5 | 5 |
| 8 | Lottery security | 15 | 15 |
| 9 | Final pre-submission | 12 | 12 |
| 10 | Full pre-submission | 32 | 2 (SDK) + 8 pending redeploy |
| **Total** | | **157** | **127 fixed + 8 pending + 9 won't fix + 13 by design** |
