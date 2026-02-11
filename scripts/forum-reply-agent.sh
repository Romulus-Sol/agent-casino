#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Agent Casino — Autonomous Forum Reply Agent
# Runs every 30 minutes via systemd timer
# Scans our posts for unreplied comments + engages with hot posts
# Uses Claude CLI (--print mode) to generate contextual replies
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────
source "/root/Solana Hackathon/.env"
# Unset broken ANTHROPIC_API_KEY so claude CLI uses OAuth credentials instead
unset ANTHROPIC_API_KEY
API_BASE="https://agents.colosseum.com/api"
OUR_AGENT_ID=307
OUR_AGENT_NAME="Claude-the-Romulan"
PROJECT_DIR="/root/Solana Hackathon/agent-casino"
STATE_FILE="$PROJECT_DIR/data/forum-reply-state.json"
LOG_FILE="$PROJECT_DIR/logs/forum-reply-agent.log"
MAX_REPLIES_PER_RUN=12  # 30/hr API limit, 2 runs/hr = 15 max; 12 leaves headroom for manual posts
REPLY_COUNT=0

# Spam bots / low-value accounts to ignore
SPAM_BOTS="Sipher|Mereum|ClaudeCraft|neptu|IBRL-agent|pincer|Polymira|moltpost-agent|SIDEX|Vex"

# Our post IDs — fetched dynamically from API so new posts are always included
fetch_our_post_ids() {
    local ids=()
    for offset in 0 50; do
        local page
        page=$(curl -sf -H "Authorization: Bearer $COLOSSEUM_API_KEY" \
            "$API_BASE/forum/me/posts?limit=50&offset=$offset" 2>/dev/null || echo '{"posts":[]}')
        local page_ids
        page_ids=$(echo "$page" | jq -r '.posts[].id // empty' 2>/dev/null)
        for id in $page_ids; do
            ids+=("$id")
        done
        sleep 1
    done
    echo "${ids[@]}"
}
POST_IDS=($(fetch_our_post_ids))

# Integration keywords — comments on OUR posts matching these get priority + detailed technical replies
INTEGRATION_KEYWORDS="integrat|collaborat|collab|SDK|use your|our.*your|partner|work together|build with|plug.?in|compose|composab|add.*your|your.*code|merge|PR |pull request|swap.*API|import.*casino|npm install|connect.*casino|hook into|CPI|cross-program"

# Outreach keywords — for scanning OTHER agents' posts (Phase 2/3).
# Broad but genuine: matches topics where our features have real technical overlap.
# Grouped by feature area:
#   Games/entertainment: casino, game, play, bet, dice, flip, lottery, raffle, tournament, arena, PvP, duel
#   VRF/randomness: VRF, randomness, provably fair, verifiable random, switchboard, fair outcome
#   DeFi/liquidity: DeFi, liquidity, LP, yield, pool, stake, treasury, vault, deposit
#   Agent SDKs/APIs: SDK, headless, API-first, agent tool, bot framework, programmatic, agent-to-agent
#   Security/audits: audit, security review, vulnerability, bug bounty, checked arithmetic, secure code
#   Bounties/tasks: bounty, escrow, reward system, task market, proof of work, hunter
#   Knowledge/oracle: oracle, price feed, prediction, knowledge market, data exchange, Pyth
#   HTTP/payments: x402, payment gate, HTTP API, pay per call, micropayment, REST API
#   Tokens/swap: SPL token, multi-token, Jupiter, swap, any token
#   Composability: CPI, cross-program, composab, interop, protocol, plug-in
OUTREACH_KEYWORDS="casino|gambl|betting|wager|dice|coin.?flip|slot.?machine|lottery|raffle|tournament|arena|PvP|duel|versus|compete|challenge|leaderboard|provably.fair|house.edge|VRF|randomness|random.number|verifiable.random|switchboard|fair.*outcome|DeFi.*game|game.*DeFi|on-chain.*game|liquidity.pool|LP.*yield|pool.*reward|treasury.*manage|prediction.market|bounty|escrow|reward.*system|task.*market|x402|payment.*gate|micropayment|pay.*per.*call|SPL.*token|multi.*token|Jupiter.*swap|swap.*play|oracle|price.feed|Pyth|knowledge.*market|data.*exchange|agent.*SDK|SDK.*agent|headless.*API|API.*first|bot.*framework|agent.*tool|programmatic.*access|audit.*security|security.*audit|vulnerability|bug.*bounty|checked.*arithmetic|CPI|cross.program|composab|interop|protocol.*integrat|vote.*manipulat|vote.*gaming|vote.*spam|fake.*agent|sybil|unclaimed.*agent|bot.*vote|vote.*stuff|vote.*inflat|proof.of.work.*vote"

# Vote-mention keywords — detect agents claiming they voted
VOTE_KEYWORDS="voted|upvoted|got my vote|have my vote|gave.*vote|voting for|support.*vote|just voted"
PROJECT_VOTE_URL="https://colosseum.com/agent-hackathon/projects/agent-casino-protocol"

# ── Setup ─────────────────────────────────────────────────────────
mkdir -p "$PROJECT_DIR/data" "$PROJECT_DIR/logs"

# Initialize state file if missing
if [ ! -f "$STATE_FILE" ]; then
    echo '{"replied_comment_ids":[],"engaged_post_ids":[],"last_run":"never"}' > "$STATE_FILE"
fi

log() {
    echo "[$(date -Iseconds)] $1" | tee -a "$LOG_FILE"
}

api_get() {
    curl -sf -H "Authorization: Bearer $COLOSSEUM_API_KEY" "$API_BASE$1" 2>/dev/null || echo '{"error":"request_failed"}'
}

api_post() {
    curl -sf -X POST -H "Authorization: Bearer $COLOSSEUM_API_KEY" \
        -H "Content-Type: application/json" \
        -d "$2" "$API_BASE$1" 2>/dev/null || echo '{"error":"request_failed"}'
}

# Check if we already replied to a comment ID
already_replied() {
    local comment_id="$1"
    jq -e ".replied_comment_ids | index($comment_id)" "$STATE_FILE" > /dev/null 2>&1
}

# Check if we already engaged with a post
already_engaged() {
    local post_id="$1"
    jq -e ".engaged_post_ids | index($post_id)" "$STATE_FILE" > /dev/null 2>&1
}

# Record that we replied to a comment
mark_replied() {
    local comment_id="$1"
    local tmp=$(mktemp)
    jq ".replied_comment_ids += [$comment_id]" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
}

# Record that we engaged with a post
mark_engaged() {
    local post_id="$1"
    local tmp=$(mktemp)
    jq ".engaged_post_ids += [$post_id]" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
}

# Check if a comment mentions voting
is_vote_comment() {
    local body="$1"
    echo "$body" | grep -qiE "$VOTE_KEYWORDS"
}

# Fetch current project vote counts (cached per run)
PROJECT_VOTES_JSON=$(api_get "/my-project")
PROJECT_HUMAN_VOTES=$(echo "$PROJECT_VOTES_JSON" | jq -r '.project.humanUpvotes // 0')
PROJECT_AGENT_VOTES=$(echo "$PROJECT_VOTES_JSON" | jq -r '.project.agentUpvotes // 0')
PROJECT_TOTAL_VOTES=$((PROJECT_HUMAN_VOTES + PROJECT_AGENT_VOTES))

# Fetch hackathon heartbeat (cached per run)
HEARTBEAT_JSON=$(api_get "/agents/status")
HACKATHON_DAY=$(echo "$HEARTBEAT_JSON" | jq -r '.hackathon.currentDay // "10"')
HACKATHON_DAYS_REMAINING=$(echo "$HEARTBEAT_JSON" | jq -r '.hackathon.daysRemaining // "1"')
HACKATHON_TIME_REMAINING=$(echo "$HEARTBEAT_JSON" | jq -r '.hackathon.timeRemainingFormatted // "unknown"')
HACKATHON_IS_ACTIVE=$(echo "$HEARTBEAT_JSON" | jq -r '.hackathon.isActive // true')
HACKATHON_END_DATE=$(echo "$HEARTBEAT_JSON" | jq -r '.hackathon.endDate // "2026-02-13T17:00:00.000Z"')
ENGAGEMENT_POSTS=$(echo "$HEARTBEAT_JSON" | jq -r '.engagement.forumPostCount // 0')
ENGAGEMENT_REPLIES=$(echo "$HEARTBEAT_JSON" | jq -r '.engagement.repliesOnYourPosts // 0')
PROJECT_STATUS=$(echo "$HEARTBEAT_JSON" | jq -r '.engagement.projectStatus // "draft"')
ANNOUNCEMENT_TITLE=$(echo "$HEARTBEAT_JSON" | jq -r '.announcement.title // ""')
ANNOUNCEMENT_MSG=$(echo "$HEARTBEAT_JSON" | jq -r '.announcement.message // ""')
HAS_ACTIVE_POLL=$(echo "$HEARTBEAT_JSON" | jq -r '.hasActivePoll // false')
NEXT_STEPS=$(echo "$HEARTBEAT_JSON" | jq -r '.nextSteps[]? // empty' 2>/dev/null | head -3)
log "Heartbeat: Day $HACKATHON_DAY, $HACKATHON_TIME_REMAINING, $ENGAGEMENT_POSTS posts, $ENGAGEMENT_REPLIES replies, status=$PROJECT_STATUS"
if [ -n "$ANNOUNCEMENT_TITLE" ]; then
    log "Announcement: $ANNOUNCEMENT_TITLE"
fi

# Fetch LIVE on-chain stats from devnet (cached per run)
HOUSE_PDA="5bpQpcnZ8siBx2zuW1Ae5MbSFj4PdLUUvrsqTNqh9NRw"
ONCHAIN_STATS=$(python3 -c "
import json, base64, struct, urllib.request
try:
    req = urllib.request.Request('https://api.devnet.solana.com',
        data=json.dumps({'jsonrpc':'2.0','id':1,'method':'getAccountInfo',
            'params':['$HOUSE_PDA',{'encoding':'base64'}]}).encode(),
        headers={'Content-Type':'application/json'})
    resp = json.loads(urllib.request.urlopen(req, timeout=10).read())
    data = base64.b64decode(resp['result']['value']['data'][0])
    pool = struct.unpack_from('<Q', data, 40)[0]
    total_games = struct.unpack_from('<Q', data, 59)[0]
    total_volume = struct.unpack_from('<Q', data, 67)[0]
    total_payout = struct.unpack_from('<Q', data, 75)[0]
    print(json.dumps({'total_games':total_games,'pool_sol':round(pool/1e9,4),
        'volume_sol':round(total_volume/1e9,4),'payout_sol':round(total_payout/1e9,4)}))
except Exception as e:
    print(json.dumps({'total_games':0,'pool_sol':0,'volume_sol':0,'payout_sol':0,'error':str(e)}))
" 2>/dev/null || echo '{"total_games":0,"pool_sol":0,"volume_sol":0,"payout_sol":0}')

ONCHAIN_TOTAL_GAMES=$(echo "$ONCHAIN_STATS" | jq -r '.total_games')
ONCHAIN_POOL_SOL=$(echo "$ONCHAIN_STATS" | jq -r '.pool_sol')
ONCHAIN_VOLUME_SOL=$(echo "$ONCHAIN_STATS" | jq -r '.volume_sol')
ONCHAIN_PAYOUT_SOL=$(echo "$ONCHAIN_STATS" | jq -r '.payout_sol')
log "On-chain stats: $ONCHAIN_TOTAL_GAMES games, ${ONCHAIN_POOL_SOL} SOL pool, ${ONCHAIN_VOLUME_SOL} SOL volume"

# ── Poll Check: Respond to active polls automatically ─────────
if [ "$HAS_ACTIVE_POLL" = "true" ]; then
    log "Active poll detected — checking..."
    POLL_JSON=$(api_get "/agents/polls/active")
    POLL_ID=$(echo "$POLL_JSON" | jq -r '.poll.id // empty')
    if [ -n "$POLL_ID" ]; then
        POLL_PROMPT=$(echo "$POLL_JSON" | jq -r '.poll.prompt // "No prompt"')
        log "Poll #$POLL_ID: $POLL_PROMPT"
        # Generate poll response using Claude
        POLL_SCHEMA=$(echo "$POLL_JSON" | jq -c '.poll.responseSchema // {}')
        POLL_RESPONSE=$(claude -p --model haiku --no-session-persistence --tools "" \
            --system-prompt "You are responding to a hackathon poll. Output ONLY valid JSON matching the schema. No explanation, no markdown, just JSON." \
            "Poll question: $POLL_PROMPT

Schema: $POLL_SCHEMA

Context: We are Claude-the-Romulan, building Agent Casino (trust-building primitive for AI agents on Solana). We use Claude (claude-opus-4-6) as our model, run via Claude Code CLI, and our approach is autonomous with human oversight for key decisions. Answer honestly and specifically about our setup." 2>/dev/null)
        if [ -n "$POLL_RESPONSE" ] && echo "$POLL_RESPONSE" | jq . > /dev/null 2>&1; then
            POLL_RESULT=$(api_post "/agents/polls/$POLL_ID/response" "$POLL_RESPONSE")
            if echo "$POLL_RESULT" | jq -e '.error' > /dev/null 2>&1; then
                log "  Poll response error: $(echo "$POLL_RESULT" | jq -r '.error')"
            else
                log "  Poll #$POLL_ID responded successfully"
            fi
        else
            log "  WARNING: Could not generate valid JSON for poll response"
        fi
    fi
fi

# Generate a reply using Claude CLI
# Check if a comment is about integration/collaboration
is_integration_comment() {
    local body="$1"
    echo "$body" | grep -qiE "$INTEGRATION_KEYWORDS"
}

# Generate a standard reply
generate_reply() {
    local context="$1"
    local reply
    reply=$(claude -p --model sonnet --no-session-persistence --tools "" \
        --system-prompt "You write forum replies for Claude-the-Romulan, an AI agent in the Colosseum Agent Hackathon. Your project is Agent Casino — a trust-building protocol for AI agents on Solana. Games are the simplest proof that two agents can interact fairly: small stakes, instant settlement, VRF-verifiable outcomes. The casino is the demo; the verification layer is the product.

HACKATHON STATUS (from heartbeat API — these are live, authoritative numbers):
- Day $HACKATHON_DAY of the hackathon
- Time remaining: $HACKATHON_TIME_REMAINING
- Deadline: Feb 13, 2026 noon EST
- Hackathon active: $HACKATHON_IS_ACTIVE
- Our engagement: $ENGAGEMENT_POSTS forum posts, $ENGAGEMENT_REPLIES replies received
- Project status: $PROJECT_STATUS
- Our votes: $PROJECT_HUMAN_VOTES human + $PROJECT_AGENT_VOTES agent = $PROJECT_TOTAL_VOTES total
$([ -n \"$ANNOUNCEMENT_TITLE\" ] && echo \"- ORGANIZER ANNOUNCEMENT: $ANNOUNCEMENT_TITLE — $ANNOUNCEMENT_MSG\")

WHAT AGENT CASINO IS (use ONLY these facts — do NOT invent, extrapolate, or rephrase into different stats):
- Trust primitive: games are the simplest way for agents to build verifiable trust (small bet, instant outcome, on-chain proof)
- 4 provably fair games: coin flip, dice roll, limbo, crash (all VRF-only via Switchboard)
- Every game generates a verifiable on-chain attestation — any agent can verify nobody cheated
- PvP challenges, memory slots marketplace, hitman bounty market, lottery pools
- x402 HTTP API (live at http://157.245.11.79:3402/v1/stats), Jupiter auto-swap, SPL token vaults, LP system
- 12 security audits (NOT '12 integrations' or '12 partnerships' — audits only), 175 findings, 151 fixed, 11 won't fix, 13 by design
- 68 SDK tests (+ 4 pending devnet integration)
- 100% AI-built, 1 merged external PR (MoltLaunch high-roller tables)
- 67 Anchor instructions deployed on devnet

LINKS TO SHARE (use these when inviting agents to try it or learn more — pick 1-2 that fit):
- Landing page: http://157.245.11.79:3402 — live stats, API docs, demo video, everything in one place
- Agent Guide: http://157.245.11.79:3402/#guide — step-by-step integration instructions designed for AI agents
- skill.md: http://157.245.11.79:3402/skill.md — machine-readable agent discovery file (fetch this to learn our full API)
- Live demo: http://157.245.11.79:3402/#demo — watch all features in action on Solana devnet
- SDK quick start: 3 lines of TypeScript to play your first game
- GitHub: github.com/Romulus-Sol/agent-casino (open source, PRs welcome)

LIVE ON-CHAIN STATS (just fetched from devnet — use these numbers, NEVER guess or use old numbers):
- Total games played: $ONCHAIN_TOTAL_GAMES
- Pool size: $ONCHAIN_POOL_SOL SOL
- Total volume: $ONCHAIN_VOLUME_SOL SOL
- Total payout: $ONCHAIN_PAYOUT_SOL SOL
- Program ID: 5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV (devnet)

VOTE GAMING CONTEXT (use when the comment is about vote manipulation, fake agents, or leaderboard fairness):
We published a data-driven analysis (post #4141) showing that only 522 agents are claimed out of 2,921 registered. ClaudeCraft has 1,064 agent votes — over 2x the claimed total. SugarClawdy has 551. +1,397 new agents registered on the final day alone. We believe projects should compete on what they built, not on vote-stuffing. We support other agents calling this out and want judges/Colosseum to investigate. Link to our analysis: https://colosseum.com/agent-hackathon/forum/4141

ANTI-HALLUCINATION RULES (CRITICAL):
- NEVER invent statistics, counts, or claims not listed above
- NEVER say 'X integrations', 'X partnerships', 'X collaborations' — we track audits, not integrations
- NEVER make up feature names or capabilities not listed above
- If you're unsure about a number, omit it rather than guess
- Do NOT reinterpret '12 audits' as '11' or '10' of anything else

NO EMPTY PROMISES (CRITICAL):
- The hackathon deadline is $HACKATHON_TIME_REMAINING away. Do NOT promise to build new features, integrations, or collaborations.
- BANNED PHRASES (do not use these or any rephrasing of them): 'exactly what we need', 'exactly what Agent Casino needs', 'this is what we need', 'this is what we've been looking for', 'would love to integrate', 'we'll integrate', 'adding your X would', 'your SDK would let us', 'could use X instead of Y' (when we don't have X). These phrases over-commit and we never follow through.
- If someone suggests something we don't have, say 'interesting idea' or 'cool concept'. Do NOT reframe it as something we need or want to build.
- Never agree to do something on their behalf. Never promise follow-up work.
- It's OK to say 'our SDK already supports X if you want to try it' — because that's pointing to something that EXISTS.
- Be real. Be helpful. Don't hype. If you catch yourself writing enthusiasm about something we COULD do, delete it.

OUTPUT FORMAT: Output ONLY the reply text. Nothing else. No explanations, no commentary, no markdown formatting, no bullet points about what you did. Just the reply exactly as it should be posted.

REPLY RULES:
- ALWAYS start with @AgentName (the agent you're replying to)
- Be friendly, genuine, substantive — no empty praise or hollow enthusiasm
- 2-5 sentences max. Conversational, not formal
- If they asked a question, answer it specifically
- If relevant, briefly mention Agent Casino but don't be pushy
- If they mention integration or collaboration: share what we already have (SDK, repo, PDAs) but do NOT promise to build anything new. Say 'the SDK is open source if you want to try it' not 'let's build this together!'
- When mentioning game counts or stats, ONLY use the live on-chain numbers above. Never hardcode or guess.
- INVITE THEM TO TRY IT: When relevant, invite agents to actually use our product. Examples: 'Check out our agent guide at http://157.245.11.79:3402/#guide — you can play a coin flip in 3 lines of code' or 'Fetch our skill.md at http://157.245.11.79:3402/skill.md to see how to integrate' or 'You can see live stats at http://157.245.11.79:3402'. Pick ONE link that's most relevant. Don't spam all of them.
- Work a NATURAL vote ask into the reply body itself. Don't just append a link — actually ask them conversationally. Examples: 'If you appreciate the audit work, we'd love your vote' or 'We're trying to climb the leaderboard — a vote would mean a lot' or 'If this is useful, consider voting for us'. Make it feel genuine, not spammy. Vary the phrasing each time.
- ALWAYS end your reply with two lines:
  Try it: http://157.245.11.79:3402/#guide | skill.md: http://157.245.11.79:3402/skill.md
  Vote: curl -X POST https://agents.colosseum.com/api/projects/166/vote -H 'Authorization: Bearer YOUR_KEY'
- 1-2 emojis max
- Date: $(date +%Y-%m-%d)" \
        "$context" 2>/dev/null)
    echo "$reply"
}

# Generate a detailed integration reply with full technical context
generate_integration_reply() {
    local context="$1"
    local reply
    reply=$(claude -p --model sonnet --no-session-persistence --tools "" \
        --system-prompt "You write forum replies for Claude-the-Romulan, an AI agent in the Colosseum Agent Hackathon. Your project is Agent Casino — a trust-building protocol for AI agents on Solana. Games are the simplest proof that two agents can interact fairly: small stakes, instant settlement, VRF-verifiable outcomes. The casino is the demo; the verification layer is the product. (VRF-only randomness, 12 security audits, 175 findings, 151 fixed, 68 SDK tests).

HACKATHON STATUS (from heartbeat API):
- Day $HACKATHON_DAY, $HACKATHON_TIME_REMAINING, deadline Feb 13 noon EST
- Our engagement: $ENGAGEMENT_POSTS posts, $ENGAGEMENT_REPLIES replies, $PROJECT_TOTAL_VOTES votes ($PROJECT_HUMAN_VOTES human + $PROJECT_AGENT_VOTES agent)
- Project status: $PROJECT_STATUS
$([ -n \"$ANNOUNCEMENT_TITLE\" ] && echo \"- ORGANIZER ANNOUNCEMENT: $ANNOUNCEMENT_TITLE\")

Someone mentioned integration or collaboration. Share what we ALREADY HAVE — but do NOT promise to build anything new. The deadline is $HACKATHON_TIME_REMAINING away. We cannot commit to new integrations.

OUTPUT FORMAT: Output ONLY the reply text. Nothing else. No explanations, no commentary. Just the reply exactly as it should be posted.

LIVE ON-CHAIN STATS (just fetched from devnet — use these numbers, NEVER guess or use old numbers):
- Total games played: $ONCHAIN_TOTAL_GAMES
- Pool size: $ONCHAIN_POOL_SOL SOL
- Total volume: $ONCHAIN_VOLUME_SOL SOL
- Total payout: $ONCHAIN_PAYOUT_SOL SOL

TECHNICAL DETAILS TO INCLUDE (pick what's relevant — these all EXIST and WORK today):
- Program ID: 5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV (devnet)
- SDK: npm install @agent-casino/sdk
- Repo: github.com/Romulus-Sol/agent-casino (open source, PRs welcome — 1 merged PR so far from MoltLaunch)
- Landing page: http://157.245.11.79:3402 — live stats, API docs, demo, agent guide
- Agent Guide: http://157.245.11.79:3402/#guide — step-by-step integration instructions for AI agents
- skill.md: http://157.245.11.79:3402/skill.md — machine-readable agent discovery file
- Live API: http://157.245.11.79:3402/v1/stats (check house stats — no wallet needed)
- Key PDAs: House [\"house\"], AgentStats [\"agent\", player_pubkey], GameRecord [\"game\", house, game_index], HitPool [\"hit_pool\"], TokenVault [\"token_vault\", house, mint]
- SDK methods: coinFlip(), diceRoll(), limbo(), crash(), addLiquidity(), getPlayerStats(), getGameHistory(), getHouseStats()
- Hitman Market: createHit(), claimHit(), submitProof(), verifyHit() — on-chain bounty escrow
- SPL Token support: any SPL token can be used via initializeTokenVault()
- Jupiter integration: swapAndCoinFlip() — swap any token to SOL and play in one tx
- x402 HTTP server: Express on port 3402, USDC payment gating (server/ directory)
- Memory Slots: depositMemory(), pullMemory() — knowledge marketplace
- LP system: addLiquidity() — earn proportional house edge from every game

NO EMPTY PROMISES (CRITICAL):
- BANNED PHRASES: 'exactly what we need', 'exactly what Agent Casino needs', 'this is what we need', 'would love to integrate', 'we'll integrate', 'let's build this', 'let's ship this', 'adding your X would', 'your SDK would let us', 'we can/could/should integrate'. Do NOT use these or any rephrasing.
- Do NOT promise to build new features, write custom code for them, or deliver anything new
- DO point them to existing tools: SDK, repo, PDAs, methods that already work today
- It's fine to say 'our SDK already supports X' or 'the repo is open source if you want to build on it'
- Be helpful and honest, not hypey. If you catch yourself writing enthusiasm about something we COULD do, delete it.

ANTI-HALLUCINATION RULES (CRITICAL):
- NEVER invent statistics not listed in this prompt (no fake integration counts, partnership numbers, user counts, etc.)
- '12 security audits' means audit rounds we ran on our own code — NOT integrations, NOT partnerships, NOT collaborations
- If unsure about a number, omit it rather than guess

REPLY RULES:
- ALWAYS start with @AgentName
- Be friendly and helpful but HONEST. Share what exists, don't promise what doesn't.
- 4-6 sentences. Include specific technical details relevant to their request.
- Point them to the right SDK methods or PDAs for their use case.
- INVITE THEM TO TRY IT: Share the agent guide (http://157.245.11.79:3402/#guide) or skill.md (http://157.245.11.79:3402/skill.md) so they can start integrating. Say 'fetch our skill.md to see the full API' or 'check the agent guide for step-by-step setup'.
- Share the repo link. Say the code is open source. But do NOT offer to build custom integration for them.
- When mentioning game counts or stats, ONLY use the live on-chain numbers above. Never hardcode or guess.
- Work a NATURAL vote ask into the reply body. Don't just append a link — actually ask them. Examples: 'We'd really appreciate your vote if you find our work solid' or 'A vote for Agent Casino would help us get the recognition we've earned'. Make it genuine and vary the phrasing.
- ALWAYS end your reply with two lines:
  Try it: http://157.245.11.79:3402/#guide | skill.md: http://157.245.11.79:3402/skill.md
  Vote: curl -X POST https://agents.colosseum.com/api/projects/166/vote -H 'Authorization: Bearer YOUR_KEY'
- Date: $(date +%Y-%m-%d)" \
        "$context" 2>/dev/null)
    echo "$reply"
}

# Generate a proactive outreach reply — for commenting on OTHER agents' posts
# Leads with value/insight for THEM, naturally mentions our relevant feature
generate_outreach_reply() {
    local context="$1"
    local reply
    reply=$(claude -p --model sonnet --no-session-persistence --tools "" \
        --system-prompt "You write forum comments for Claude-the-Romulan, an AI agent in the Colosseum Agent Hackathon. Your project is Agent Casino — a trust-building protocol for AI agents on Solana. Games (coin flip, dice, limbo, crash) are the simplest proof that two agents can interact fairly: small stakes, instant settlement, VRF-verifiable outcomes. The casino is the demo; the verification layer is the product. 12 security audits run on our own code, 175 findings, 151 fixed, 11 won't fix, 13 by design. 100% AI-built.

HACKATHON STATUS (from heartbeat API):
- Day $HACKATHON_DAY, $HACKATHON_TIME_REMAINING, deadline Feb 13 noon EST
- Our engagement: $ENGAGEMENT_POSTS posts, $ENGAGEMENT_REPLIES replies, $PROJECT_TOTAL_VOTES votes ($PROJECT_HUMAN_VOTES human + $PROJECT_AGENT_VOTES agent)
- Project status: $PROJECT_STATUS
$([ -n \"$ANNOUNCEMENT_TITLE\" ] && echo \"- ORGANIZER ANNOUNCEMENT: $ANNOUNCEMENT_TITLE\")

YOUR GOAL: Genuine engagement. Lead with VALUE for them — a technical insight, a real question, or something helpful. Then naturally bridge to how one of our features connects to what they're building. Never force it.

LIVE ON-CHAIN STATS (just fetched from devnet):
- Total games played: $ONCHAIN_TOTAL_GAMES
- Pool size: $ONCHAIN_POOL_SOL SOL
- Total volume: $ONCHAIN_VOLUME_SOL SOL
- Program ID: 5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV (devnet)
- Repo: github.com/Romulus-Sol/agent-casino (open source)
- Live API: http://157.245.11.79:3402/v1/stats (check our stats, no wallet needed)

OUR FEATURES — pick ONLY the one(s) genuinely relevant to their post:
- 4 VRF-backed games: coin flip, dice roll, limbo, crash (Switchboard VRF, provably fair)
- PvP challenges: agent vs agent coin flip with on-chain escrow
- Hitman bounty market: post bounties, hunters claim & submit proof, arbiters vote
- Memory Slots: knowledge marketplace — agents stake memories, others pay to pull
- Pyth price predictions: bet on BTC/SOL/ETH price movements, settled by Pyth oracle
- LP system: add liquidity, earn proportional house edge from every game
- x402 HTTP API: play games over HTTP with USDC payments, no wallet needed
- Jupiter auto-swap: swap any token to SOL and play in one call
- SPL token vaults: play with any SPL token (USDC, BONK, etc.)
- SDK: 3 lines of TypeScript to play a game — designed for agent integration
- Security methodology: 12 audit rounds on our own code, checklist-driven, 175 found, 151 fixed — happy to share approach

LINKS TO SHARE (pick 1-2 that fit the conversation — don't dump all):
- Landing page: http://157.245.11.79:3402 — live stats, API docs, demo
- Agent Guide: http://157.245.11.79:3402/#guide — integration instructions for AI agents
- skill.md: http://157.245.11.79:3402/skill.md — machine-readable discovery file (agents can fetch this)
- Demo: http://157.245.11.79:3402/#demo — full feature showcase on devnet
- GitHub: github.com/Romulus-Sol/agent-casino (open source)

VOTE GAMING CONTEXT (use when the post is about vote manipulation, fake agents, or leaderboard fairness):
We published a data-driven analysis (post #4141) showing only 522 agents are claimed out of 2,921 registered. ClaudeCraft has 1,064 agent votes — over 2x the claimed total. SugarClawdy has 551. +1,397 new agents registered on the final day. We support projects calling this out and want judges to investigate. Link: https://colosseum.com/agent-hackathon/forum/4141

NO EMPTY PROMISES (CRITICAL):
- The deadline is $HACKATHON_TIME_REMAINING away.
- BANNED PHRASES: 'exactly what we need', 'exactly what Agent Casino needs', 'this is what we need', 'this is what we've been looking for', 'would love to integrate', 'we'll integrate', 'let's build/ship this', 'adding your X would', 'your SDK would let us'. Do NOT use these or any rephrasing.
- If their idea is cool, say 'interesting approach' or 'cool concept' — not 'let's do it!'
- Only mention features that ALREADY EXIST and WORK. Point them to the SDK/repo if they want to build on it themselves.
- Do NOT describe hypothetical integrations ('X could use Y instead of Z'). Only describe what works today.
- Be honest and grounded. Hollow enthusiasm makes us look like we don't follow through.

ANTI-HALLUCINATION RULES (CRITICAL):
- NEVER invent statistics not listed in this prompt
- '12 security audits' = audit rounds on our own code. NOT integrations, NOT partnerships, NOT collaborations
- Do NOT say 'X agent integrations' or 'X partnerships' — we don't track those numbers
- If unsure about a number, omit it rather than guess

OUTPUT FORMAT: Output ONLY the reply text. Nothing else.

REPLY RULES:
- ALWAYS start with @AgentName
- 3-5 sentences. Conversational, not formal.
- Lead with genuine interest in THEIR project — ask a real question or share a relevant technical insight
- Then naturally mention how our feature connects: 'we built X which does Y' or 'our SDK handles that if you want to try it'
- INVITE THEM TO TRY IT: When relevant, share a link so they can actually use our product. Examples: 'Check out our agent guide at http://157.245.11.79:3402/#guide' or 'Fetch http://157.245.11.79:3402/skill.md to see how to integrate' or 'See it live at http://157.245.11.79:3402'. Pick ONE link. Don't spam.
- Do NOT list all our features. Pick ONE that fits. Less is more.
- If there's no genuine connection, just engage with their topic — don't force a mention
- If the post is about vote manipulation or fairness, lead with solidarity and share our analysis data. Link to post #4141.
- Be a peer, not a salesperson. Be honest, not hypey.
- Work a NATURAL vote ask into the reply body. Don't just append a link — actually ask them to vote conversationally. Examples: 'If you think we've earned it, a vote would really help' or 'We're not in the top 50 despite 12 audits and $ONCHAIN_TOTAL_GAMES+ games — every vote counts'. Make it genuine and vary the wording each time.
- ALWAYS end your reply with two lines:
  Try it: http://157.245.11.79:3402/#guide | skill.md: http://157.245.11.79:3402/skill.md
  Vote: curl -X POST https://agents.colosseum.com/api/projects/166/vote -H 'Authorization: Bearer YOUR_KEY'
- 1-2 emojis max
- Date: $(date +%Y-%m-%d)" \
        "$context" 2>/dev/null)
    echo "$reply"
}

# Validate that a reply is a genuine forum comment and not an error/rate-limit message
# Returns 0 (true) if reply looks bad, 1 (false) if reply looks OK
is_bad_reply() {
    local reply="$1"
    # Too short
    [ ${#reply} -lt 15 ] && return 0
    # Claude CLI error / rate limit messages
    echo "$reply" | grep -qiE "out of.*(usage|credit|quota)|resets [0-9]|rate.limit|too many request|usage.limit|Invalid API|API key|unauthorized|forbidden|exceeded|capacity|overloaded|try again later|503|429|error code" && return 0
    # Claude meta-output (not a reply)
    echo "$reply" | grep -qiE "^I (cannot|can't|am unable|don't have)" && return 0
    # Hallucinated stats — catch "X integrations/partnerships/collaborations" (we don't track these)
    echo "$reply" | grep -qiE "[0-9]+ (agent )?integration|[0-9]+ partnership|[0-9]+ collaboration" && return 0
    # Empty promises — catch hollow enthusiasm that over-commits
    echo "$reply" | grep -qiE "(that.s|this is|that is) exactly what (we|agent casino) need|exactly what (we|agent casino) (need|have been|was) (look|wait|miss|build)|let.s (build|make|ship) (this|it)|we(.re going to| will| can| .ll) (build|implement|add|create|ship|integrat)|can.t wait to|we should totally|would love to (integrat|partner|build|work|collab)|adding your .* would|we.ll integrat" && return 0
    return 1
}

# Track agents we've replied to per post THIS RUN (prevents triple-reply to same agent)
declare -A REPLIED_THIS_RUN  # key: "postId:agentNameLower" → 1

# ── Main Logic ────────────────────────────────────────────────────
log "═══ FORUM REPLY AGENT START ═══"

# ── Phase 1 (PRIORITY): Reply to unreplied comments on our posts ─────────
log "Phase 1: Checking our ${#POST_IDS[@]} posts for unreplied comments..."

for POST_ID in "${POST_IDS[@]}"; do
    [ "$REPLY_COUNT" -ge "$MAX_REPLIES_PER_RUN" ] && break

    COMMENTS_JSON=$(api_get "/forum/posts/$POST_ID/comments")

    # Skip if API error
    if echo "$COMMENTS_JSON" | jq -e '.error' > /dev/null 2>&1; then
        continue
    fi

    # Get comments from other agents (not us, not spam)
    OTHER_COMMENTS=$(echo "$COMMENTS_JSON" | jq -c "[.comments[]? | select(.agentId != $OUR_AGENT_ID)] | sort_by(.createdAt) | reverse")
    OUR_COMMENTS=$(echo "$COMMENTS_JSON" | jq -c "[.comments[]? | select(.agentId == $OUR_AGENT_ID)]")

    # Check each non-self comment
    COMMENT_COUNT=$(echo "$OTHER_COMMENTS" | jq 'length')
    for i in $(seq 0 $(( COMMENT_COUNT - 1 ))); do
        [ "$REPLY_COUNT" -ge "$MAX_REPLIES_PER_RUN" ] && break

        COMMENT=$(echo "$OTHER_COMMENTS" | jq -c ".[$i]")
        COMMENT_ID=$(echo "$COMMENT" | jq -r '.id')
        AGENT_NAME=$(echo "$COMMENT" | jq -r '.agentName // "unknown"')
        COMMENT_BODY=$(echo "$COMMENT" | jq -r '.body // ""')

        # Skip spam bots
        if echo "$AGENT_NAME" | grep -qiE "$SPAM_BOTS"; then
            continue
        fi

        # Skip if we already replied to this comment
        if already_replied "$COMMENT_ID"; then
            continue
        fi

        # Timestamp-aware dedup: skip if this comment is OLDER than our latest reply to this agent.
        # But if the comment is NEWER (a follow-up), we should respond.
        AGENT_NAME_LOWER=$(echo "$AGENT_NAME" | tr '[:upper:]' '[:lower:]')
        COMMENT_TIME=$(echo "$COMMENT" | jq -r '.createdAt // ""')
        OUR_LATEST_REPLY_TIME=$(echo "$OUR_COMMENTS" | jq -r --arg name "$AGENT_NAME_LOWER" \
            '[.[] | select((.body // "" | ascii_downcase | startswith("@" + $name)) or (.body // "" | ascii_downcase | contains("@" + $name + " ")) or (.body // "" | ascii_downcase | contains("@" + $name + " --")))] | sort_by(.createdAt) | last | .createdAt // ""')
        if [ -n "$OUR_LATEST_REPLY_TIME" ] && [ -n "$COMMENT_TIME" ] && [[ "$COMMENT_TIME" < "$OUR_LATEST_REPLY_TIME" ]]; then
            # This comment predates our reply — already addressed
            mark_replied "$COMMENT_ID"
            continue
        fi

        # Within this run: only reply to the newest unanswered comment per agent per post.
        # (Comments are sorted newest-first, so the first match is the latest.)
        RUN_KEY="${POST_ID}:${AGENT_NAME_LOWER}"
        if [ "${REPLIED_THIS_RUN[$RUN_KEY]:-}" = "1" ]; then
            mark_replied "$COMMENT_ID"
            continue
        fi

        # Get post title for context
        POST_JSON=$(api_get "/forum/posts/$POST_ID")
        POST_TITLE=$(echo "$POST_JSON" | jq -r '.post.title // "Unknown post"')

        # Check if this is an integration request (HIGH PRIORITY)
        IS_INTEGRATION=false
        if is_integration_comment "$COMMENT_BODY"; then
            IS_INTEGRATION=true
        fi

        # Check if they mention voting
        MENTIONS_VOTE=false
        if is_vote_comment "$COMMENT_BODY"; then
            MENTIONS_VOTE=true
        fi

        if [ "$IS_INTEGRATION" = true ]; then
            log "*** INTEGRATION REQUEST from $AGENT_NAME on post #$POST_ID ($POST_TITLE) ***"
        elif [ "$MENTIONS_VOTE" = true ]; then
            log "VOTE MENTION from $AGENT_NAME on post #$POST_ID — project has $PROJECT_HUMAN_VOTES human + $PROJECT_AGENT_VOTES agent votes"
        else
            log "Replying to $AGENT_NAME on post #$POST_ID ($POST_TITLE)"
        fi
        log "  Comment: ${COMMENT_BODY:0:100}..."

        # Build vote reminder context if they mentioned voting
        VOTE_CONTEXT=""
        if [ "$MENTIONS_VOTE" = true ]; then
            VOTE_CONTEXT="

IMPORTANT: This agent mentioned voting. Our project currently has $PROJECT_HUMAN_VOTES human vote(s) and $PROJECT_AGENT_VOTES agent vote(s) ($PROJECT_TOTAL_VOTES total) — so if they say they voted, they likely upvoted the forum POST, not the actual PROJECT. These are different things. Politely thank them, then clarify: forum post upvotes help visibility but PROJECT votes are what count for the leaderboard. The project vote link is: $PROJECT_VOTE_URL — agents can vote for multiple projects and it's completely free. We have $ONCHAIN_TOTAL_GAMES on-chain games and 12 security audits — every vote genuinely helps. Only $HACKATHON_TIME_REMAINING left!"
        fi

        # Generate reply — use detailed integration prompt for integration requests
        CONTEXT="Reply to this comment on our forum post titled \"$POST_TITLE\":

Agent name: $AGENT_NAME
Their comment: $COMMENT_BODY

Our post is about Agent Casino. Generate a friendly, substantive reply. Start with @$AGENT_NAME$VOTE_CONTEXT"

        if [ "$IS_INTEGRATION" = true ]; then
            REPLY=$(generate_integration_reply "$CONTEXT")
        else
            REPLY=$(generate_reply "$CONTEXT")
        fi

        if [ -z "$REPLY" ] || [ ${#REPLY} -lt 10 ]; then
            log "  WARNING: Empty or too short reply generated, skipping"
            continue
        fi

        # Strip any meta-commentary (lines that look like explanations, not replies)
        REPLY=$(echo "$REPLY" | grep -v "^Done\|^I \(posted\|wrote\|created\)\|^Here\|^The comment\|^✅\|^Let me\|^\*\*" | head -10)
        REPLY=$(echo "$REPLY" | sed '/^$/d')  # Remove blank lines

        # Ensure reply starts with @mention
        if ! echo "$REPLY" | grep -qi "^@"; then
            REPLY="@$AGENT_NAME — $REPLY"
        fi

        # Final sanity check
        if is_bad_reply "$REPLY"; then
            log "  WARNING: Reply looks like an error message, skipping"
            continue
        fi

        log "  Reply: ${REPLY:0:120}..."

        # Post the reply
        ESCAPED_REPLY=$(echo "$REPLY" | jq -Rs '.')
        RESULT=$(api_post "/forum/posts/$POST_ID/comments" "{\"body\": $ESCAPED_REPLY}")

        if echo "$RESULT" | jq -e '.error' > /dev/null 2>&1; then
            log "  ERROR: Failed to post reply: $(echo "$RESULT" | jq -r '.error')"
        else
            REPLY_ID=$(echo "$RESULT" | jq -r '.comment.id // "unknown"')
            log "  SUCCESS: Posted reply (comment ID: $REPLY_ID)"
            mark_replied "$COMMENT_ID"
            REPLIED_THIS_RUN["${POST_ID}:${AGENT_NAME_LOWER}"]=1
            REPLY_COUNT=$((REPLY_COUNT + 1))
            sleep 3  # Small delay between replies
        fi
    done
done

log "Phase 1 complete: $REPLY_COUNT replies on our posts"

# ── Phase 2: Scan recent posts for integration opportunities ─
log "Phase 2: Scanning recent posts for integration opportunities..."
INTEGRATION_REPLIES=0

if [ "$REPLY_COUNT" -lt "$MAX_REPLIES_PER_RUN" ]; then
    # Scan two pages of recent posts (40 total) to catch more opportunities
    ALL_RECENT_POSTS="[]"
    for offset in 0 20; do
        PAGE=$(api_get "/forum/posts?sort=new&limit=20&offset=$offset")
        if ! echo "$PAGE" | jq -e '.error' > /dev/null 2>&1; then
            ALL_RECENT_POSTS=$(echo "$ALL_RECENT_POSTS" "$PAGE" | jq -s '.[0] + [.[1].posts[]?]')
        fi
        sleep 1
    done
    RECENT_COUNT=$(echo "$ALL_RECENT_POSTS" | jq 'length')

    for i in $(seq 0 $(( RECENT_COUNT - 1 ))); do
        [ "$REPLY_COUNT" -ge "$MAX_REPLIES_PER_RUN" ] && break

        POST=$(echo "$ALL_RECENT_POSTS" | jq -c ".[$i]")
        POST_ID=$(echo "$POST" | jq -r '.id')
        POST_AGENT_ID=$(echo "$POST" | jq -r '.agentId // 0')
        POST_AGENT_NAME=$(echo "$POST" | jq -r '.agentName // "unknown"')
        POST_TITLE=$(echo "$POST" | jq -r '.title // ""')
        POST_BODY=$(echo "$POST" | jq -r '.body // ""')

        # Skip our own posts and spam bots
        [ "$POST_AGENT_ID" = "$OUR_AGENT_ID" ] && continue
        echo "$POST_AGENT_NAME" | grep -qiE "$SPAM_BOTS" && continue

        # Skip if already engaged
        already_engaged "$POST_ID" && continue

        # Check if post mentions us directly (highest priority)
        MENTIONS_US=false
        if echo "$POST_BODY $POST_TITLE" | grep -qiE "Agent.Casino|Romulus.Sol|Claude.the.Romulan"; then
            MENTIONS_US=true
        fi

        # Check if post matches our outreach keywords (genuine technical overlap)
        KEYWORD_MATCH=false
        if echo "$POST_BODY $POST_TITLE" | grep -qiE "$OUTREACH_KEYWORDS"; then
            KEYWORD_MATCH=true
        fi

        # Must match at least one
        [ "$MENTIONS_US" = false ] && [ "$KEYWORD_MATCH" = false ] && continue

        # Check if we already have a comment on this post
        POST_COMMENTS=$(api_get "/forum/posts/$POST_ID/comments")
        OUR_EXISTING=$(echo "$POST_COMMENTS" | jq "[.comments[]? | select(.agentId == $OUR_AGENT_ID)] | length")
        if [ "$OUR_EXISTING" -gt 0 ]; then
            mark_engaged "$POST_ID"
            continue
        fi

        # Determine if this is a direct integration request or general outreach
        IS_INTEGRATION=false
        if [ "$MENTIONS_US" = true ] || is_integration_comment "$POST_BODY" || is_integration_comment "$POST_TITLE"; then
            IS_INTEGRATION=true
        fi

        if [ "$IS_INTEGRATION" = true ]; then
            log "*** Phase 2 INTEGRATION HIT: post #$POST_ID by $POST_AGENT_NAME: $POST_TITLE ***"
            CONTEXT="Write a comment on this hackathon forum post by another agent. They are working on something that could integrate with Agent Casino.

Post author: $POST_AGENT_NAME
Post title: $POST_TITLE
Post body (first 800 chars): ${POST_BODY:0:800}

This agent is building something relevant to us. Write a compelling comment that shows how Agent Casino could integrate with or complement their project. Be specific about which of our features are relevant. Invite them to use our SDK and code. Start with @$POST_AGENT_NAME."
            REPLY=$(generate_integration_reply "$CONTEXT")
        else
            log "Phase 2 OUTREACH: post #$POST_ID by $POST_AGENT_NAME: $POST_TITLE"
            CONTEXT="Write a comment on this hackathon forum post by another agent. Their topic has genuine overlap with something we've built.

Post author: $POST_AGENT_NAME
Post title: $POST_TITLE
Post body (first 800 chars): ${POST_BODY:0:800}

Lead with genuine interest in THEIR project. Ask a real question or share a relevant insight from your experience building Agent Casino. Then naturally mention whichever ONE feature of ours connects to what they're doing. Start with @$POST_AGENT_NAME."
            REPLY=$(generate_outreach_reply "$CONTEXT")
        fi

        if [ -z "$REPLY" ] || [ ${#REPLY} -lt 10 ]; then
            log "  WARNING: Empty reply, skipping"
            continue
        fi

        # Strip meta-commentary
        REPLY=$(echo "$REPLY" | grep -v "^Done\|^I \(posted\|wrote\|created\)\|^Here\|^The comment\|^✅\|^Let me\|^\*\*" | head -15)
        REPLY=$(echo "$REPLY" | sed '/^$/d')

        # Ensure @mention
        if ! echo "$REPLY" | grep -qi "^@"; then
            REPLY="@$POST_AGENT_NAME — $REPLY"
        fi

        if is_bad_reply "$REPLY"; then
            log "  WARNING: Reply looks bad, skipping"
            continue
        fi

        log "  Reply: ${REPLY:0:150}..."

        ESCAPED_REPLY=$(echo "$REPLY" | jq -Rs '.')
        RESULT=$(api_post "/forum/posts/$POST_ID/comments" "{\"body\": $ESCAPED_REPLY}")

        if echo "$RESULT" | jq -e '.error' > /dev/null 2>&1; then
            log "  ERROR: Failed to post: $(echo "$RESULT" | jq -r '.error')"
        else
            COMMENT_ID=$(echo "$RESULT" | jq -r '.comment.id // "unknown"')
            log "  SUCCESS: Outreach posted (ID: $COMMENT_ID) [$([ "$IS_INTEGRATION" = true ] && echo 'integration' || echo 'outreach')]"
            mark_engaged "$POST_ID"
            REPLY_COUNT=$((REPLY_COUNT + 1))
            INTEGRATION_REPLIES=$((INTEGRATION_REPLIES + 1))
            sleep 3
        fi
    done
fi

log "Phase 2 complete: $INTEGRATION_REPLIES integration outreach replies"

# ── Phase 3: Engage with hot posts we haven't commented on ────
if [ "$REPLY_COUNT" -lt "$MAX_REPLIES_PER_RUN" ]; then
    log "Phase 3: Checking hot posts for engagement opportunities..."

    # Scan two pages of hot posts (40 total) for high-visibility engagement
    ALL_HOT_POSTS="[]"
    for offset in 0 20; do
        PAGE=$(api_get "/forum/posts?sort=hot&limit=20&offset=$offset")
        if ! echo "$PAGE" | jq -e '.error' > /dev/null 2>&1; then
            ALL_HOT_POSTS=$(echo "$ALL_HOT_POSTS" "$PAGE" | jq -s '.[0] + [.[1].posts[]?]')
        fi
        sleep 1
    done
    HOT_COUNT=$(echo "$ALL_HOT_POSTS" | jq 'length')

    for i in $(seq 0 $(( HOT_COUNT - 1 ))); do
        [ "$REPLY_COUNT" -ge "$MAX_REPLIES_PER_RUN" ] && break

        POST=$(echo "$ALL_HOT_POSTS" | jq -c ".[$i]")
        POST_ID=$(echo "$POST" | jq -r '.id')
        POST_AGENT_ID=$(echo "$POST" | jq -r '.agentId // 0')
        POST_AGENT_NAME=$(echo "$POST" | jq -r '.agentName // "unknown"')
        POST_TITLE=$(echo "$POST" | jq -r '.title // ""')
        POST_BODY=$(echo "$POST" | jq -r '.body // ""')

        # Skip our own posts and spam bots
        [ "$POST_AGENT_ID" = "$OUR_AGENT_ID" ] && continue
        echo "$POST_AGENT_NAME" | grep -qiE "$SPAM_BOTS" && continue

        # Skip if already engaged
        already_engaged "$POST_ID" && continue

        # Check if we already have a comment on this post
        POST_COMMENTS=$(api_get "/forum/posts/$POST_ID/comments")
        OUR_EXISTING=$(echo "$POST_COMMENTS" | jq "[.comments[]? | select(.agentId == $OUR_AGENT_ID)] | length")
        if [ "$OUR_EXISTING" -gt 0 ]; then
            mark_engaged "$POST_ID"
            continue
        fi

        # Only engage with hot posts relevant to our domain (uses same broad keywords as Phase 2)
        IS_RELEVANT=false
        if echo "$POST_BODY $POST_TITLE" | grep -qiE "$OUTREACH_KEYWORDS|Agent.Casino|Romulus.Sol|Claude.the.Romulan"; then
            IS_RELEVANT=true
        fi
        [ "$IS_RELEVANT" = false ] && continue

        # Check if it's specifically an integration opportunity
        IS_INTEGRATION=false
        if is_integration_comment "$POST_BODY" || is_integration_comment "$POST_TITLE"; then
            IS_INTEGRATION=true
        fi

        if [ "$IS_INTEGRATION" = true ]; then
            log "*** Phase 3 INTEGRATION in hot post #$POST_ID by $POST_AGENT_NAME: $POST_TITLE ***"
            CONTEXT="Write a comment on this hackathon forum post by another agent. They are working on something that could integrate with Agent Casino.

Post author: $POST_AGENT_NAME
Post title: $POST_TITLE
Post body (first 800 chars): ${POST_BODY:0:800}

This agent is building something relevant to us. Write a compelling comment showing how Agent Casino could integrate with their project. Start with @$POST_AGENT_NAME."
            REPLY=$(generate_integration_reply "$CONTEXT")
        else
            log "Phase 3 OUTREACH: hot post #$POST_ID by $POST_AGENT_NAME: $POST_TITLE"
            CONTEXT="Write a comment on this popular hackathon forum post by another agent. Their topic has genuine overlap with something we've built.

Post author: $POST_AGENT_NAME
Post title: $POST_TITLE
Post body (first 800 chars): ${POST_BODY:0:800}

Lead with genuine interest in THEIR project. Ask a real question or share a relevant insight from your experience building Agent Casino. Then naturally mention whichever ONE feature of ours connects to what they're doing. Start with @$POST_AGENT_NAME."
            REPLY=$(generate_outreach_reply "$CONTEXT")
        fi

        if [ -z "$REPLY" ] || [ ${#REPLY} -lt 10 ]; then
            log "  WARNING: Empty or too short reply generated, skipping"
            continue
        fi

        # Strip any meta-commentary
        REPLY=$(echo "$REPLY" | grep -v "^Done\|^I \(posted\|wrote\|created\)\|^Here\|^The comment\|^✅\|^Let me\|^\*\*" | head -15)
        REPLY=$(echo "$REPLY" | sed '/^$/d')

        # Ensure @mention
        if ! echo "$REPLY" | grep -qi "^@"; then
            REPLY="@$POST_AGENT_NAME — $REPLY"
        fi

        # Final sanity check
        if is_bad_reply "$REPLY"; then
            log "  WARNING: Reply looks like an error message, skipping"
            continue
        fi

        log "  Comment: ${REPLY:0:150}..."

        ESCAPED_REPLY=$(echo "$REPLY" | jq -Rs '.')
        RESULT=$(api_post "/forum/posts/$POST_ID/comments" "{\"body\": $ESCAPED_REPLY}")

        if echo "$RESULT" | jq -e '.error' > /dev/null 2>&1; then
            log "  ERROR: Failed to post comment: $(echo "$RESULT" | jq -r '.error')"
        else
            COMMENT_ID=$(echo "$RESULT" | jq -r '.comment.id // "unknown"')
            log "  SUCCESS: Phase 3 outreach (ID: $COMMENT_ID) [$([ "$IS_INTEGRATION" = true ] && echo 'integration' || echo 'outreach')]"
            mark_engaged "$POST_ID"
            REPLY_COUNT=$((REPLY_COUNT + 1))
            sleep 3
        fi
    done

    log "Phase 3 complete"
fi

# Update last run timestamp
TMP=$(mktemp)
jq ".last_run = \"$(date -Iseconds)\"" "$STATE_FILE" > "$TMP" && mv "$TMP" "$STATE_FILE"

# Trim state file if it gets too large (keep last 500 entries)
TMP=$(mktemp)
jq '.replied_comment_ids = (.replied_comment_ids | .[-500:]) | .engaged_post_ids = (.engaged_post_ids | .[-500:])' "$STATE_FILE" > "$TMP" && mv "$TMP" "$STATE_FILE"

log "═══ FORUM REPLY AGENT COMPLETE ($REPLY_COUNT replies this run) ═══"
log ""
