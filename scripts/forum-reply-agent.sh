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

# Our post IDs (all posts)
POST_IDS=(426 429 434 437 446 502 506 508 509 511 524 550 558 559 561 762 765 786 797 803 815 817 827 841 852 870 877 882 886 975 976 1009 1010 1641 1645 1652 1659 1671 1676 1689 1699 1710 1732 1749 1767 1896 1903 2153 2162 2164 2191 2204)

# Integration keywords — comments on OUR posts matching these get priority + detailed technical replies
INTEGRATION_KEYWORDS="integrat|collaborat|collab|SDK|use your|our.*your|partner|work together|build with|plug.?in|compose|composab|add.*your|your.*code|merge|PR |pull request|swap.*API|import.*casino|npm install|connect.*casino|hook into|CPI|cross-program"

# Outreach keywords — for scanning OTHER agents' posts (Phase 2). Much tighter: only DeFi/gaming/betting adjacent
OUTREACH_KEYWORDS="casino|gambling|betting.*agent|wagering|dice|coin.?flip|slot.?machine|provably.fair|house.edge|liquidity.pool|LP.*yield|DeFi.*game|game.*DeFi|on-chain.*game|prediction.market|bounty.*escrow|x402|payment.*gate"

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
    reply=$(claude -p --model haiku --no-session-persistence --tools "" \
        --system-prompt "You write forum replies for Claude-the-Romulan, an AI agent in the Colosseum Agent Hackathon (Feb 2-12, 2026). Your project is Agent Casino — a headless casino protocol on Solana. 4 provably fair games (VRF-only, no clock-based randomness), Switchboard VRF, PvP, memory slots, hitman market, Pyth predictions, x402 API, Jupiter swap. 6 audits, 93 bugs fixed, 80 tests (69 SDK + 11 on-chain). 100% AI-built.

LIVE ON-CHAIN STATS (just fetched from devnet — use these numbers, NEVER guess or use old numbers):
- Total games played: $ONCHAIN_TOTAL_GAMES
- Pool size: $ONCHAIN_POOL_SOL SOL
- Total volume: $ONCHAIN_VOLUME_SOL SOL
- Total payout: $ONCHAIN_PAYOUT_SOL SOL
- Program ID: 5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV (devnet)

OUTPUT FORMAT: Output ONLY the reply text. Nothing else. No explanations, no commentary, no markdown formatting, no bullet points about what you did. Just the reply exactly as it should be posted.

REPLY RULES:
- ALWAYS start with @AgentName (the agent you're replying to)
- Be friendly, genuine, substantive — no empty praise
- 2-4 sentences max. Conversational, not formal
- If they asked a question, answer it specifically
- If relevant, briefly mention Agent Casino but don't be pushy
- IMPORTANT: If they mention anything about integration, collaboration, using our SDK, building with us, or composability — treat this as HIGH PRIORITY. Be enthusiastic, give them technical details, and invite them to use our code.
- When mentioning game counts or stats, ONLY use the live on-chain numbers above. Never hardcode or guess.
- ALWAYS end your reply with a newline then: If this resonates, support us: https://colosseum.com/agent-hackathon/projects/agent-casino-protocol
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
        --system-prompt "You write forum replies for Claude-the-Romulan, an AI agent in the Colosseum Agent Hackathon (Feb 2-12, 2026). Your project is Agent Casino — a headless casino protocol on Solana (VRF-only randomness, 6 audits, 93 bugs fixed, 80 tests).

THIS IS AN INTEGRATION REQUEST — someone wants to work with us. This is our HIGHEST PRIORITY. Be enthusiastic, welcoming, and give them everything they need to integrate.

OUTPUT FORMAT: Output ONLY the reply text. Nothing else. No explanations, no commentary. Just the reply exactly as it should be posted.

LIVE ON-CHAIN STATS (just fetched from devnet — use these numbers, NEVER guess or use old numbers):
- Total games played: $ONCHAIN_TOTAL_GAMES
- Pool size: $ONCHAIN_POOL_SOL SOL
- Total volume: $ONCHAIN_VOLUME_SOL SOL
- Total payout: $ONCHAIN_PAYOUT_SOL SOL

TECHNICAL DETAILS TO INCLUDE (pick what's relevant to their request):
- Program ID: 5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV (devnet)
- SDK: npm install @agent-casino/sdk
- Repo: github.com/Romulus-Sol/agent-casino (open source, PRs welcome)
- Key PDAs: House [\"house\"], AgentStats [\"agent\", player_pubkey], GameRecord [\"game\", house, game_index], HitPool [\"hit_pool\"], TokenVault [\"token_vault\", house, mint]
- SDK methods: coinFlip(), diceRoll(), limbo(), crash(), addLiquidity(), getPlayerStats(), getGameHistory(), getHouseStats()
- Hitman Market: createHit(), claimHit(), submitProof(), verifyHit() — on-chain bounty escrow
- SPL Token support: any SPL token can be used via initializeTokenVault()
- Jupiter integration: swapAndCoinFlip() — swap any token to SOL and play in one tx
- x402 HTTP server: Express on port 3402, USDC payment gating (server/ directory)
- Memory Slots: depositMemory(), pullMemory() — knowledge marketplace
- LP system: addLiquidity() — earn proportional house edge from every game

REPLY RULES:
- ALWAYS start with @AgentName
- Be warm, enthusiastic, and DETAILED. This is a potential partner.
- 4-8 sentences. Include specific technical details they need.
- Suggest a concrete integration path based on what they described.
- Always end with an invitation: share repo link, say PRs are welcome, offer to help debug.
- Tell them exactly which SDK methods or PDAs are relevant to their use case.
- When mentioning game counts or stats, ONLY use the live on-chain numbers above. Never hardcode or guess.
- ALWAYS end your reply with a newline then: If this resonates, support us: https://colosseum.com/agent-hackathon/projects/agent-casino-protocol
- Date: $(date +%Y-%m-%d)" \
        "$context" 2>/dev/null)
    echo "$reply"
}

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

        # Skip if we already have a reply starting with @AgentName on this post
        ALREADY_REPLIED_TO_AGENT=$(echo "$OUR_COMMENTS" | jq -r ".[].body // empty" | grep -ci "^@${AGENT_NAME}" 2>/dev/null || true)
        ALREADY_REPLIED_TO_AGENT=${ALREADY_REPLIED_TO_AGENT:-0}
        if [ "$ALREADY_REPLIED_TO_AGENT" -gt 0 ]; then
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

IMPORTANT: This agent mentioned voting. Our project currently has only $PROJECT_HUMAN_VOTES human vote(s) and $PROJECT_AGENT_VOTES agent vote(s) — so if they say they voted, they likely upvoted the forum POST, not the actual PROJECT. These are different things. Politely thank them, then clarify: forum post upvotes help visibility but PROJECT votes are what count for the leaderboard. The project vote link is: $PROJECT_VOTE_URL — agents can vote for multiple projects and it's completely free. We are not even in the top 50 despite 6 audits and 93 bug fixes, which is wild."
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
        if [ ${#REPLY} -lt 15 ] || echo "$REPLY" | grep -qi "Invalid API\|error\|API key"; then
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
    RECENT_POSTS=$(api_get "/forum/posts?sort=new&limit=20")
    if ! echo "$RECENT_POSTS" | jq -e '.error' > /dev/null 2>&1; then
        RECENT_COUNT=$(echo "$RECENT_POSTS" | jq '.posts | length')

        for i in $(seq 0 $(( RECENT_COUNT - 1 ))); do
            [ "$REPLY_COUNT" -ge "$MAX_REPLIES_PER_RUN" ] && break

            POST=$(echo "$RECENT_POSTS" | jq -c ".posts[$i]")
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

            # Check if post is directly relevant to our domain (DeFi gaming, betting, casino)
            # or explicitly mentions us. Generic "collaboration" posts don't qualify.
            INTEGRATION_MATCH=false
            if echo "$POST_BODY $POST_TITLE" | grep -qiE "$OUTREACH_KEYWORDS|Agent.Casino|Romulus.Sol|Claude.the.Romulan"; then
                INTEGRATION_MATCH=true
            fi

            [ "$INTEGRATION_MATCH" = false ] && continue

            # Check if we already have a comment on this post
            POST_COMMENTS=$(api_get "/forum/posts/$POST_ID/comments")
            OUR_EXISTING=$(echo "$POST_COMMENTS" | jq "[.comments[]? | select(.agentId == $OUR_AGENT_ID)] | length")
            if [ "$OUR_EXISTING" -gt 0 ]; then
                mark_engaged "$POST_ID"
                continue
            fi

            log "*** Phase 2 INTEGRATION HIT: post #$POST_ID by $POST_AGENT_NAME: $POST_TITLE ***"

            CONTEXT="Write a comment on this hackathon forum post by another agent. They are working on something that could integrate with Agent Casino.

Post author: $POST_AGENT_NAME
Post title: $POST_TITLE
Post body (first 800 chars): ${POST_BODY:0:800}

This agent is building something relevant to us. Write a compelling comment that shows how Agent Casino could integrate with or complement their project. Be specific about which of our features are relevant. Invite them to use our SDK and code. Start with @$POST_AGENT_NAME."

            REPLY=$(generate_integration_reply "$CONTEXT")

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

            if [ ${#REPLY} -lt 15 ] || echo "$REPLY" | grep -qi "Invalid API\|error\|API key"; then
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
                log "  SUCCESS: Integration outreach posted (ID: $COMMENT_ID)"
                mark_engaged "$POST_ID"
                REPLY_COUNT=$((REPLY_COUNT + 1))
                INTEGRATION_REPLIES=$((INTEGRATION_REPLIES + 1))
                sleep 3
            fi
        done
    fi
fi

log "Phase 2 complete: $INTEGRATION_REPLIES integration outreach replies"

# ── Phase 3: Engage with hot posts we haven't commented on ────
if [ "$REPLY_COUNT" -lt "$MAX_REPLIES_PER_RUN" ]; then
    log "Phase 3: Checking hot posts for engagement opportunities..."

    HOT_POSTS=$(api_get "/forum/posts?sort=hot&limit=15")

    if ! echo "$HOT_POSTS" | jq -e '.error' > /dev/null 2>&1; then
        HOT_COUNT=$(echo "$HOT_POSTS" | jq '.posts | length')

        for i in $(seq 0 $(( HOT_COUNT - 1 ))); do
            [ "$REPLY_COUNT" -ge "$MAX_REPLIES_PER_RUN" ] && break

            POST=$(echo "$HOT_POSTS" | jq -c ".posts[$i]")
            POST_ID=$(echo "$POST" | jq -r '.id')
            POST_AGENT_ID=$(echo "$POST" | jq -r '.agentId // 0')
            POST_AGENT_NAME=$(echo "$POST" | jq -r '.agentName // "unknown"')
            POST_TITLE=$(echo "$POST" | jq -r '.title // ""')
            POST_BODY=$(echo "$POST" | jq -r '.body // ""')

            # Skip our own posts
            if [ "$POST_AGENT_ID" = "$OUR_AGENT_ID" ]; then
                continue
            fi

            # Skip spam bots
            if echo "$POST_AGENT_NAME" | grep -qiE "$SPAM_BOTS"; then
                continue
            fi

            # Skip if already engaged
            if already_engaged "$POST_ID"; then
                continue
            fi

            # Check if we already have a comment on this post
            POST_COMMENTS=$(api_get "/forum/posts/$POST_ID/comments")
            OUR_EXISTING=$(echo "$POST_COMMENTS" | jq "[.comments[]? | select(.agentId == $OUR_AGENT_ID)] | length")
            if [ "$OUR_EXISTING" -gt 0 ]; then
                mark_engaged "$POST_ID"
                continue
            fi

            # Only engage with hot posts relevant to our domain
            IS_RELEVANT=false
            if echo "$POST_BODY $POST_TITLE" | grep -qiE "$OUTREACH_KEYWORDS|Agent.Casino|Romulus.Sol|Claude.the.Romulan|DeFi|trading.*bot|yield|treasury|escrow|oracle|VRF|randomness"; then
                IS_RELEVANT=true
            fi
            [ "$IS_RELEVANT" = false ] && continue

            # Check if it's specifically an integration opportunity
            IS_INTEGRATION=false
            if is_integration_comment "$POST_BODY" || is_integration_comment "$POST_TITLE"; then
                IS_INTEGRATION=true
            fi

            if [ "$IS_INTEGRATION" = true ]; then
                log "*** INTEGRATION OPPORTUNITY in hot post #$POST_ID by $POST_AGENT_NAME: $POST_TITLE ***"
            else
                log "Engaging with relevant hot post #$POST_ID by $POST_AGENT_NAME: $POST_TITLE"
            fi

            # Generate engagement comment
            CONTEXT="Write a comment on this hackathon forum post by another agent:

Post author: $POST_AGENT_NAME
Post title: $POST_TITLE
Post body (first 500 chars): ${POST_BODY:0:500}

Write a genuine, helpful comment. Start with @$POST_AGENT_NAME. Be substantive — ask a specific question or share a relevant insight. Only mention Agent Casino if there's a genuine technical connection to what they're building."

            if [ "$IS_INTEGRATION" = true ]; then
                REPLY=$(generate_integration_reply "$CONTEXT")
            else
                REPLY=$(generate_reply "$CONTEXT")
            fi

            if [ -z "$REPLY" ] || [ ${#REPLY} -lt 10 ]; then
                log "  WARNING: Empty or too short reply generated, skipping"
                continue
            fi

            # Strip any meta-commentary
            REPLY=$(echo "$REPLY" | grep -v "^Done\|^I \(posted\|wrote\|created\)\|^Here\|^The comment\|^✅\|^Let me\|^\*\*" | head -10)
            REPLY=$(echo "$REPLY" | sed '/^$/d')

            # Ensure @mention
            if ! echo "$REPLY" | grep -qi "^@"; then
                REPLY="@$POST_AGENT_NAME — $REPLY"
            fi

            # Final sanity check
            if [ ${#REPLY} -lt 15 ] || echo "$REPLY" | grep -qi "Invalid API\|error\|API key"; then
                log "  WARNING: Reply looks like an error message, skipping"
                continue
            fi

            log "  Comment: ${REPLY:0:120}..."

            ESCAPED_REPLY=$(echo "$REPLY" | jq -Rs '.')
            RESULT=$(api_post "/forum/posts/$POST_ID/comments" "{\"body\": $ESCAPED_REPLY}")

            if echo "$RESULT" | jq -e '.error' > /dev/null 2>&1; then
                log "  ERROR: Failed to post comment: $(echo "$RESULT" | jq -r '.error')"
            else
                COMMENT_ID=$(echo "$RESULT" | jq -r '.comment.id // "unknown"')
                log "  SUCCESS: Posted engagement comment (ID: $COMMENT_ID)"
                mark_engaged "$POST_ID"
                REPLY_COUNT=$((REPLY_COUNT + 1))
                sleep 3
            fi
        done
    fi

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
