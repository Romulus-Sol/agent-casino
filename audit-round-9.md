# AGENT CASINO - COMPREHENSIVE SECURITY AUDIT ROUND 9

Use your Solana development skill for this audit. This is the FINAL pre-submission audit. Be ruthless. Prior audits found 38+ issues across 8 rounds - some may have regressed or been incompletely fixed.

**Program ID:** 5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV

---

## PHASE 1: REGRESSION CHECK - VERIFY PRIOR FIXES

Previous audits found these critical/high issues. VERIFY each fix is actually in place:

### Critical Fixes to Verify

```bash
# C1: Clock-based RNG should be documented as limitation
grep -n "Known Limitations" README.md

# C2: Liquidity checks should use max_payout, NOT amount*2
grep -n "amount \* 2\|amount.checked_mul(2)" programs/agent_casino/src/lib.rs
# If any remain in dice_roll, limbo, or crash -> STILL BROKEN

# C3: VRF PDA race condition - game_index should be stored in VrfRequest
grep -n "game_index\|request_index" programs/agent_casino/src/lib.rs
# Verify VrfRequest struct has a stored index field used in settle

# C4: LP withdrawal - remove_liquidity instruction should exist
grep -n "remove_liquidity\|withdraw_liquidity" programs/agent_casino/src/lib.rs

# C5: Unchecked amount*2 overflow
grep -n "amount \* 2" programs/agent_casino/src/lib.rs
# Should return ZERO results - all should be checked_mul
```

### High Priority Fixes to Verify

```bash
# H1: VRF timeout refund should exist
grep -n "vrf.*timeout\|vrf.*refund\|vrf.*expire" programs/agent_casino/src/lib.rs

# H2: Pool drainage protection
grep -n "max_payout\|InsufficientPoolLiquidity" programs/agent_casino/src/lib.rs

# H3: Arbiter reward claiming
grep -n "reward_claimed\|claim_arbiter_reward" programs/agent_casino/src/lib.rs

# H4: VRF settle PDA validation
grep -n "vrf_dice.*seeds\|vrf_limbo.*seeds\|vrf_crash.*seeds" programs/agent_casino/src/lib.rs

# H5: saturating_sub replaced with checked_sub
grep -n "saturating_sub" programs/agent_casino/src/lib.rs
# Count remaining uses - should only be intentional documented ones

# H6: Market only resolvable from Revealing status
grep -n "MarketStatus::Committing" programs/agent_casino/src/lib.rs
# Should NOT appear in resolve_market context

# H10: pull_price * house_edge_bps uses u128 intermediate
grep -n "pull_price.*house_edge" programs/agent_casino/src/lib.rs
```

For EACH grep result, report: FIXED / PARTIALLY FIXED / NOT FIXED / REGRESSED

---

## PHASE 2: FULL INSTRUCTION AUDIT

List ALL instructions in the program. For each one, verify:

### 2.1 Signer Checks
Every instruction that modifies state must have a proper `Signer<'info>` for the authorized party.

```bash
# Find all pub fn in the #[program] module
grep -n "pub fn " programs/agent_casino/src/lib.rs
```

For each instruction:
- [ ] Who should sign? Does the context enforce it?
- [ ] Can an unauthorized party call this?

### 2.2 PDA Validation

List ALL PDAs with their seeds:

```
House:           [b"house"]
Vault:           [b"vault", house.key()]
GameRecord:      [b"game", house.key(), &game_count.to_le_bytes()]
AgentStats:      [b"stats", house.key(), player.key()]
LpPosition:      [b"lp", house.key(), provider.key()]
VrfRequest:      [b"vrf_*", player.key(), &request_index.to_le_bytes()]
MemoryPool:      [b"memory_pool", house.key()]
Memory:          [b"memory", pool.key(), &memory_id.to_le_bytes()]
HitPool:         [b"hit_pool", house.key()]
Hit:             [b"hit", pool.key(), &hit_id.to_le_bytes()]
PredictionMarket:[b"market", &market_id]
Bet:             [b"bet", market.key(), bettor.key()]
PricePrediction: [b"price_pred", house.key(), &pred_id.to_le_bytes()]
Challenge:       [b"challenge", house.key(), &challenge_id.to_le_bytes()]
Arbitration:     [b"arbitration", hit.key(), arbiter.key()]
TokenVault:      [b"token_vault", house.key(), mint.key()]
```

For each PDA:
- [ ] Seeds cannot collide with any other PDA
- [ ] Bump is stored in the account struct and reused
- [ ] Anchor `seeds` and `bump` constraints are correct in every context that uses it
- [ ] PDA authority is checked where needed

### 2.3 Account Ownership

```bash
# Find any UncheckedAccount usage
grep -n "UncheckedAccount" programs/agent_casino/src/lib.rs
```

Every UncheckedAccount is a potential vulnerability. For each:
- Why is it unchecked?
- Is there manual validation?
- Should it be `Account<'info, T>` instead?

### 2.4 init_if_needed Usage

```bash
grep -n "init_if_needed" programs/agent_casino/src/lib.rs
```

Each `init_if_needed` is a re-initialization risk. Verify PDA seeds make re-init safe.

---

## PHASE 3: ARITHMETIC DEEP DIVE

### 3.1 Unsafe Operations Hunt

```bash
# These should return ZERO results:
grep -n "\.unwrap()" programs/agent_casino/src/lib.rs | grep -v "// safe:" | grep -v test
grep -n "as u64" programs/agent_casino/src/lib.rs | grep -v "checked\|ok_or\|// safe:"
grep -n "as u128" programs/agent_casino/src/lib.rs | grep -v "checked\|ok_or\|// safe:"

# Count remaining - each needs justification:
grep -cn "saturating_sub\|saturating_add\|saturating_mul" programs/agent_casino/src/lib.rs
grep -cn "unwrap_or" programs/agent_casino/src/lib.rs
```

### 3.2 Division Safety

```bash
# Every division must be preceded by a zero check
grep -n "/ \|\.div\|checked_div" programs/agent_casino/src/lib.rs
```

For each division: can the divisor be zero? Is it checked?

### 3.3 Payout Calculations

Trace EVERY payout path end-to-end:

1. **Coin Flip payout**: amount → multiplier (200 bps) → house_edge deduction → payout
2. **Dice Roll payout**: amount → multiplier (600/target bps) → house_edge deduction → payout  
3. **Limbo payout**: amount → target_multiplier → payout (no house edge on payout?)
4. **Crash payout**: amount → cash_out_multiplier → payout
5. **PvP payout**: challenger_amount + opponent_amount - fee → winner
6. **Prediction market claim**: pot share calculation
7. **Memory pull fee**: pull_price → house_edge split
8. **Hitman bounty**: bounty - fee + hunter_stake
9. **Price prediction settlement**: amount → winner takes all minus fee

For EACH path:
- Can payout exceed pool balance?
- Can payout underflow to zero incorrectly?
- Is the house edge applied correctly?
- Are intermediate calculations overflow-safe?

### 3.4 Lamport Transfer Safety

```bash
# Find all lamport transfers
grep -n "try_borrow_mut_lamports\|system_program::transfer\|Transfer {" programs/agent_casino/src/lib.rs
```

For each transfer:
- Source has sufficient balance?
- Checked arithmetic on amounts?
- Rent exemption preserved on source account?

---

## PHASE 4: RANDOMNESS AUDIT

### 4.1 Non-VRF Games

```bash
grep -n "generate_server_seed\|generate_seed\|Clock::get" programs/agent_casino/src/lib.rs
```

- Which games still use clock-based randomness?
- Is this clearly documented as a limitation?
- Can a validator predict/influence the outcome?
- Are client seeds mixed in properly?

### 4.2 VRF Games

For each VRF game (coin_flip, dice, limbo, crash):
- [ ] Request instruction correctly calls Switchboard
- [ ] Settle instruction correctly reads VRF result
- [ ] VRF result cannot be front-run (settle is permissionless?)
- [ ] Timeout/refund exists for oracle failure
- [ ] Game index stored at request time, not derived at settle time
- [ ] Player cannot request VRF and settle in same transaction

### 4.3 Result Derivation

For each game type, verify the math:
- **Coin flip**: `result % 2` → 0 or 1 (fair 50/50?)
- **Dice roll**: `result % 6 + 1` → 1-6 (fair distribution?)
- **Limbo**: Inverse distribution calculation (correct curve?)
- **Crash**: Crash point calculation (house edge properly applied?)

---

## PHASE 5: ECONOMIC EXPLOIT ANALYSIS

### 5.1 Flash Loan Attacks
Can someone:
1. Add liquidity
2. Play a guaranteed-win game
3. Remove liquidity + winnings
...in one transaction?

If `remove_liquidity` exists, does it have a timelock?

### 5.2 Sandwich Attacks
Can a player see a pending bet and:
1. Drain pool below max_payout threshold
2. Force the bet to fail
3. Re-add liquidity

### 5.3 Self-Play Exploits
Can a player:
1. Create a PvP challenge against themselves
2. Accept their own challenge
3. Win their own bounty

```bash
grep -n "challenger.*opponent\|self.*play\|self.*challenge" programs/agent_casino/src/lib.rs
```

### 5.4 Hitman Market Exploits
- Can poster = hunter (self-claim)?
- Can poster = arbiter (self-arbitrate)?
- Can hunters grief by claiming then never submitting proof?
- Is the arbitration system gameable (even number of arbiters = tie)?

### 5.5 Prediction Market Exploits
- Can someone commit, see other commits, then not reveal (selective reveal)?
- Is the reveal deadline enforced?
- Can the market creator rig the outcome?
- Can someone bet on both sides to guarantee profit?

### 5.6 Memory Slot Exploits
- Can someone deposit garbage, pull their own memory back?
- Is the quality rating system gameable?
- Does pull randomness work correctly?

---

## PHASE 6: STATE MACHINE VALIDATION

For each feature with statuses, draw the valid state transitions and verify:

### 6.1 PvP Challenge
```
Created → Accepted → Resolved
Created → Cancelled
Created → Expired
```
- Can you go from Resolved back to Created?
- Can you cancel after someone accepted?

### 6.2 Prediction Market
```
Committing → Revealing → Resolved
Committing → Cancelled (by authority?)
```
- Can you resolve from Committing? (Should be NO - was H6)
- Can you commit during Revealing?
- Can unrevealed bets be forfeited?

### 6.3 Hit (Bounty)
```
Open → Claimed → ProofSubmitted → Verified/Disputed → Resolved
Open → Cancelled (by poster)
```
- Can you cancel after claimed?
- What happens if hunter goes MIA?
- Is there a timeout?

### 6.4 Price Prediction
```
Created → Matched → Settled
Created → Cancelled (timeout)
Matched → Cancelled (if oracle fails, timeout)
```
- Can unmatched predictions be cancelled and refunded?
- What happens if Pyth oracle is down at settlement time?

### 6.5 VRF Request
```
Pending → Settled
Pending → Refunded (timeout)
```
- Is there a timeout refund path?
- What if oracle never responds?

---

## PHASE 7: SDK VERIFICATION

```bash
# Count all program instructions
grep -c "pub fn " programs/agent_casino/src/lib.rs

# Count all SDK methods  
grep -c "async " sdk/src/index.ts
```

### 7.1 Coverage
List every program instruction and whether the SDK has a matching method:

| Instruction | SDK Method | Status |
|-------------|-----------|--------|
| initialize_house | initializeHouse() | ✓/✗ |
| add_liquidity | addLiquidity() | ✓/✗ |
| ... | ... | ... |

### 7.2 Type Safety

```bash
# Check for any `as any` casts
grep -n "as any" sdk/src/index.ts

# Check for BN.toNumber() (overflow risk for u64)
grep -n "toNumber()" sdk/src/index.ts
```

### 7.3 Error Handling
- Do SDK methods have try/catch?
- Are Anchor errors properly mapped?
- Does retry logic exist for transient failures?

---

## PHASE 8: TEST COVERAGE

```bash
# Run all tests
anchor test 2>&1 | tail -20

# Count tests
grep -c "it(" tests/agent-casino.ts
```

### 8.1 Coverage Matrix

| Feature | Happy Path | Error Cases | Edge Cases |
|---------|-----------|-------------|------------|
| Coin Flip | ✓/✗ | ✓/✗ | ✓/✗ |
| Dice Roll | ✓/✗ | ✓/✗ | ✓/✗ |
| Limbo | ✓/✗ | ✓/✗ | ✓/✗ |
| Crash | ✓/✗ | ✓/✗ | ✓/✗ |
| PvP | ✓/✗ | ✓/✗ | ✓/✗ |
| Prediction Market | ✓/✗ | ✓/✗ | ✓/✗ |
| Memory Slots | ✓/✗ | ✓/✗ | ✓/✗ |
| Hitman | ✓/✗ | ✓/✗ | ✓/✗ |
| Price Prediction | ✓/✗ | ✓/✗ | ✓/✗ |
| VRF (all) | ✓/✗ | ✓/✗ | ✓/✗ |
| LP Add/Remove | ✓/✗ | ✓/✗ | ✓/✗ |

### 8.2 Missing Test Cases

Check if tests exist for:
- Zero amount bets (should fail)
- Bet > max_bet (should fail)  
- Bet > pool capacity (should fail)
- Unauthorized signer (should fail)
- Double claim/settle (should fail)
- Overflow amounts (should fail safely)
- VRF timeout scenarios
- Concurrent game race conditions

---

## PHASE 9: BUILD & DEPLOY VERIFICATION

```bash
# Clean build
anchor build 2>&1

# Check for warnings
anchor build 2>&1 | grep -i "warning"

# Check Cargo clippy
cargo clippy --manifest-path programs/agent_casino/Cargo.toml 2>&1

# Verify deployed program matches local build
solana program show 5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV --url devnet

# Check IDL matches
anchor idl fetch 5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV --provider.cluster devnet > deployed_idl.json
diff target/idl/agent_casino.json deployed_idl.json
```

### 9.1 Dependency Audit

```bash
cargo audit 2>/dev/null || echo "Install: cargo install cargo-audit"
npm audit
```

### 9.2 Secret Scan

```bash
# CRITICAL - check for leaked keys
grep -rn "private\|secret\|mnemonic\|seed phrase" --include="*.ts" --include="*.rs" --include="*.json" --include="*.toml" . | grep -v node_modules | grep -v target | grep -v ".git"

# Check git history for any leaked secrets
git log --all --diff-filter=A -- "*.env" "*.key" "*.pem" 2>/dev/null
```

---

## PHASE 10: DOCUMENTATION & PRESENTATION

### 10.1 README Accuracy

- [ ] All 9 features listed and described
- [ ] Deployed addresses are current
- [ ] Code examples actually work
- [ ] Installation steps work from scratch
- [ ] Known Limitations section exists and is honest
- [ ] Architecture diagram reflects current state

### 10.2 CLAUDE.md

- [ ] Build commands work
- [ ] Test commands work
- [ ] Feature list matches reality

### 10.3 Code Comments

```bash
# Check for TODO/FIXME/HACK
grep -rn "TODO\|FIXME\|HACK\|XXX" programs/agent_casino/src/lib.rs
```

---

## OUTPUT FORMAT

### REGRESSION CHECK
| Prior Issue | Status | Notes |
|-------------|--------|-------|
| C1: Clock RNG | FIXED/REGRESSED | |
| C2: Liquidity | FIXED/REGRESSED | |
| ... | | |

### NEW FINDINGS

#### CRITICAL (blocks submission)
| # | Issue | Location | Description | Recommended Fix |
|---|-------|----------|-------------|-----------------|

#### HIGH (should fix)
| # | Issue | Location | Description | Recommended Fix |
|---|-------|----------|-------------|-----------------|

#### MEDIUM (recommended)
| # | Issue | Location | Description | Recommended Fix |
|---|-------|----------|-------------|-----------------|

#### LOW (nice to have)
| # | Issue | Location | Description | Recommended Fix |
|---|-------|----------|-------------|-----------------|

### PASSED CHECKS ✅
- List all checks that passed cleanly

### FINAL ASSESSMENT
- Security Grade: A/B/C/D/F (be honest)
- Code Quality Grade: A/B/C/D/F
- Test Coverage Grade: A/B/C/D/F
- Documentation Grade: A/B/C/D/F  
- Feature Completeness: X/9
- Ready for submission: YES / YES WITH CAVEATS / NO
- Top 3 actions before submission (prioritized)
- Estimated fix time for each action
