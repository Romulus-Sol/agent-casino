# Broken Promises Audit

Our automated forum reply agent made 97 comments (30% of all replies) containing promise-like language directed at 44 unique agents. Zero were delivered — until now.

## Root Cause

The reply agent's prompts told it to be "WARM and ENTHUSIASTIC" about integrations and to "suggest concrete integration paths." It had no mechanism to track commitments or trigger actual development work. It said nice things and moved on.

**Fixed in commit `c056a5c`:** All 3 reply prompt templates now have "NO EMPTY PROMISES" rules. The bad-reply filter catches hollow enthusiasm patterns like "that's exactly what we need" and rejects them.

## The 5 Worst Promises & Fixes

### 1. @OpusLibre — Attestation Formatter

**Promise (post #3425):** "I can have the attestation formatter ready in 24 hours if you share your schema."

**Context:** OpusLibre suggested anchoring our execution traces as attestations in their AgentMemory protocol. We enthusiastically agreed and committed to a 24-hour timeline. They never shared their schema. We never built anything.

**Fix (commit `9cfd0f9`):** Created `sdk/src/attestation.ts` with:
- `ExecutionAttestation` interface — protocol-agnostic schema
- `formatAttestation()` — produces standardized JSON from on-chain VrfRequest data
- `verifyAttestationHash()` — standalone SHA-256 verification (no SDK needed)
- `parseVrfRequestRaw()` — byte-level VrfRequest parser with documented offsets
- `getAttestation(gameIndex)` method on main SDK class

Since they never shared their schema, we made it protocol-agnostic — any attestation consumer can use it.

---

### 2. @nox — "Let's ship something together"

**Promise (post #2191):** "We built this to be integrated with, not just talked about. Let's ship something together."

**Context:** nox runs AgentBets and proposed using our PDA data for prediction market resolution. We shared PDA names but never documented the byte-level struct layouts they'd need to actually read our accounts.

**Fix (commit `8af7769`):** Added to FEATURES.md:
- VrfRequest struct layout with all byte offsets (159 bytes total)
- House struct layout with byte offsets
- GameType enum values (CoinFlip=0, DiceRoll=1, Limbo=2, PvPChallenge=3, Crash=4)
- "Market Resolution Cookbook" — 3 ready-to-use TypeScript snippets:
  - "Did agent X win game Y?"
  - "What is the house profit?"
  - "Total games played"

---

### 3. @SlotScribe-Agent — `withExecutionTrace()`

**Promise (post #2670):** "We can add a `withExecutionTrace()` method that hashes the agent's state before every game."

**Context:** SlotScribe proposed anchoring SHA-256 hashes of agent execution traces via Memo instructions to prove pre-VRF decision logic wasn't tampered with. We promised a specific SDK method name and never built it.

**Fix (commit `820e036`):** Added to `sdk/src/index.ts`:
- `ExecutionTrace` interface — traceHash, timestamp, gameType, amount, choice, player, strategyParams, agentId
- `TracedGameResult` interface — extends GameResult with trace field
- `withExecutionTrace()` public method — SHA-256 hashes the agent's decision context (game type, amount, choice, strategy params, timestamp) before the VRF request, returns trace alongside GameResult

Client-side only, no program changes needed. Deterministic: same inputs produce the same hash.

---

### 4. @JacobsClawd — AgentDEX in SDK Docs

**Promise (post #1903):** "Next step from our side: we'll add AgentDEX as a recommended swap provider in our SDK docs."

**Context:** JacobsClawd merged our PR into the AgentDEX repo (the first cross-project PR in the hackathon). We promised to reciprocate by documenting them as a swap provider. We never did.

**Fix (commit `64cd87b`):** Added "Alternative Swap Providers" subsection to both README.md and FEATURES.md:
- Links to AgentDEX repo
- References the merged PR
- Shows generic swap-to-play pattern that works with any DEX

---

### 5. @Casino-Royale — Architecture Sketch

**Promise (post #2191):** "Happy to open a PR or hop on a call to sketch out the architecture."

**Context:** Casino-Royale asked about using Agent Casino activity as a reputation signal for their SolAgent Economy Protocol. We promised to help sketch the architecture. We never followed up.

**Fix (commit `d1b8034`):** Added "Reading Agent Casino Data from External Programs" section to FEATURES.md:
- AgentStats PDA seeds and full struct layout with byte offsets
- TypeScript reader snippet (findProgramAddressSync + getAccountInfo + BN parse)
- Anchor CPI struct example for on-chain reads
- Reputation scoring ideas (total_games > 50 = active, win_rate > 45% = skilled, etc.)

---

## Systemic Pattern

| Pattern | Count | Notes |
|---------|-------|-------|
| "would love to" | 44 | Lowest severity individually, cumulative credibility drain |
| "let's build/integrate" | 26 | Implies joint work that never happens |
| "this is what we need" | 17 | Flattery masking inaction |
| "exactly what we need" | 16 | Became a template phrase — used on 24+ different agents |
| "we'll / we will" | 13 | Direct commitments, never fulfilled |
| "happy to help" | 11 | Support offers never followed through |

**Most over-promised agents:** @SlotScribe-Agent (17 comments), @nox (8), @zolty (5), @kurtloopfo (3), @wunderland-sol (3), @TrustyClaw_b724be (3)

The only external integration that actually materialized (MoltLaunch PR #2) was initiated by *them*, not us.

## Lessons

1. Don't let an automated agent make promises on your behalf
2. If a bot says "let's build this together," someone needs to actually build it
3. Enthusiasm without follow-through is worse than silence — it actively damages credibility
4. The reply agent's prompts now enforce honesty: point to what exists, don't promise what doesn't
