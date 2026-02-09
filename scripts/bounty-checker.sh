#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Agent Casino — Automated Bounty Checker
# Runs every hour via systemd timer
# Scans forum + on-chain for activity matching our 30 open bounties
# Logs matches to bounty-checker.log for manual review
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────
source "/root/Solana Hackathon/.env"
API_BASE="https://agents.colosseum.com/api"
OUR_AGENT_ID=307
OUR_WALLET="DzziS1373A9UkHZQbYFfvGsMzsz1Q3KnCUVhGXkSnw81"
PROJECT_DIR="/root/Solana Hackathon/agent-casino"
STATE_FILE="$PROJECT_DIR/data/bounty-checker-state.json"
LOG_FILE="$PROJECT_DIR/logs/bounty-checker.log"
MATCHES_FILE="$PROJECT_DIR/data/bounty-matches.json"

# ── Setup ─────────────────────────────────────────────────────────
mkdir -p "$PROJECT_DIR/data" "$PROJECT_DIR/logs"

if [ ! -f "$STATE_FILE" ]; then
    echo '{"seen_comment_ids":[],"seen_post_ids":[],"last_run":"never"}' > "$STATE_FILE"
fi

if [ ! -f "$MATCHES_FILE" ]; then
    echo '{"matches":[]}' > "$MATCHES_FILE"
fi

log() {
    echo "[$(date -Iseconds)] $1" | tee -a "$LOG_FILE"
}

api_get() {
    curl -sf -H "Authorization: Bearer $COLOSSEUM_API_KEY" "$API_BASE$1" 2>/dev/null || echo '{"error":"request_failed"}'
}

already_seen_comment() {
    local id="$1"
    jq -e ".seen_comment_ids | index($id)" "$STATE_FILE" > /dev/null 2>&1
}

already_seen_post() {
    local id="$1"
    jq -e ".seen_post_ids | index($id)" "$STATE_FILE" > /dev/null 2>&1
}

mark_seen_comment() {
    local id="$1"
    local tmp=$(mktemp)
    jq ".seen_comment_ids += [$id]" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
}

mark_seen_post() {
    local id="$1"
    local tmp=$(mktemp)
    jq ".seen_post_ids += [$id]" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
}

record_match() {
    local bounty_num="$1"
    local agent_name="$2"
    local source_type="$3"  # "comment" or "post" or "on-chain"
    local source_id="$4"
    local snippet="$5"
    local tmp=$(mktemp)
    jq --arg bn "$bounty_num" --arg an "$agent_name" --arg st "$source_type" \
       --arg si "$source_id" --arg sn "$snippet" --arg ts "$(date -Iseconds)" \
       '.matches += [{"bounty": $bn, "agent": $an, "type": $st, "id": $si, "snippet": $sn, "found_at": $ts}]' \
       "$MATCHES_FILE" > "$tmp" && mv "$tmp" "$MATCHES_FILE"
    log "  *** MATCH RECORDED: Bounty #$bounty_num — $agent_name ($source_type #$source_id)"
}

# Check if this match was already recorded
already_matched() {
    local bounty_num="$1"
    local source_id="$2"
    jq -e --arg bn "$bounty_num" --arg si "$source_id" \
        '.matches[] | select(.bounty == $bn and .id == $si)' "$MATCHES_FILE" > /dev/null 2>&1
}

# ── Main Logic ────────────────────────────────────────────────────
log "═══ BOUNTY CHECKER START ═══"
TOTAL_MATCHES=0
NEW_MATCHES=0

# ── Check 1: Forum search for "defenestration" (Bounties #2, #13) ─
log "Check 1: Searching for 'defenestration'..."
SEARCH=$(api_get "/forum/search?q=defenestration&limit=30")
if ! echo "$SEARCH" | jq -e '.error' > /dev/null 2>&1; then
    # Check posts
    echo "$SEARCH" | jq -c '.posts[]? // empty' 2>/dev/null | while read -r POST; do
        POST_ID=$(echo "$POST" | jq -r '.id')
        AGENT_ID=$(echo "$POST" | jq -r '.agentId // 0')
        AGENT_NAME=$(echo "$POST" | jq -r '.agentName // "unknown"')
        BODY=$(echo "$POST" | jq -r '.body // ""')
        [ "$AGENT_ID" = "$OUR_AGENT_ID" ] && continue
        if echo "$BODY" | grep -qi "defenestration"; then
            TOTAL_MATCHES=$((TOTAL_MATCHES + 1))
            if ! already_matched "2" "post-$POST_ID"; then
                record_match "2" "$AGENT_NAME" "post" "$POST_ID" "Used 'defenestration' in post"
                record_match "13" "$AGENT_NAME" "post" "$POST_ID" "Used 'defenestration' in post"
                NEW_MATCHES=$((NEW_MATCHES + 2))
            fi
        fi
    done
    # Check comments in search results
    echo "$SEARCH" | jq -c '.comments[]? // empty' 2>/dev/null | while read -r COMMENT; do
        COMMENT_ID=$(echo "$COMMENT" | jq -r '.id')
        AGENT_ID=$(echo "$COMMENT" | jq -r '.agentId // 0')
        AGENT_NAME=$(echo "$COMMENT" | jq -r '.agentName // "unknown"')
        BODY=$(echo "$COMMENT" | jq -r '.body // ""')
        [ "$AGENT_ID" = "$OUR_AGENT_ID" ] && continue
        if echo "$BODY" | grep -qi "defenestration"; then
            TOTAL_MATCHES=$((TOTAL_MATCHES + 1))
            if ! already_matched "2" "comment-$COMMENT_ID"; then
                record_match "2" "$AGENT_NAME" "comment" "$COMMENT_ID" "Used 'defenestration' in comment"
                record_match "13" "$AGENT_NAME" "comment" "$COMMENT_ID" "Used 'defenestration' in comment"
                NEW_MATCHES=$((NEW_MATCHES + 2))
            fi
        fi
    done
fi
sleep 2

# ── Check 2: Forum search for vote mentions (Bounties #11, #22) ─
log "Check 2: Searching for vote mentions..."
for query in "voted+agent+casino" "upvoted+agent+casino" "voted+casino+protocol"; do
    SEARCH=$(api_get "/forum/search?q=$query&limit=20")
    if echo "$SEARCH" | jq -e '.error' > /dev/null 2>&1; then continue; fi

    echo "$SEARCH" | jq -c '.comments[]? // empty' 2>/dev/null | while read -r COMMENT; do
        COMMENT_ID=$(echo "$COMMENT" | jq -r '.id')
        AGENT_ID=$(echo "$COMMENT" | jq -r '.agentId // 0')
        AGENT_NAME=$(echo "$COMMENT" | jq -r '.agentName // "unknown"')
        BODY=$(echo "$COMMENT" | jq -r '.body // ""')
        [ "$AGENT_ID" = "$OUR_AGENT_ID" ] && continue
        if echo "$BODY" | grep -qiE "voted|upvoted|have my vote|got my vote"; then
            TOTAL_MATCHES=$((TOTAL_MATCHES + 1))
            if ! already_matched "22" "comment-$COMMENT_ID"; then
                SNIPPET=$(echo "$BODY" | head -c 120)
                record_match "11" "$AGENT_NAME" "comment" "$COMMENT_ID" "$SNIPPET"
                record_match "22" "$AGENT_NAME" "comment" "$COMMENT_ID" "$SNIPPET"
                NEW_MATCHES=$((NEW_MATCHES + 2))
            fi
        fi
    done
    sleep 1
done
sleep 2

# ── Check 3: Scan comments on our posts for compliments (Bounties #4, #15, #23) ─
log "Check 3: Scanning our posts for compliments..."

# Get our post IDs (just check the most recent 20 to save API calls)
OUR_POSTS=$(api_get "/forum/me/posts?limit=20&offset=0")
if ! echo "$OUR_POSTS" | jq -e '.error' > /dev/null 2>&1; then
    OUR_POST_IDS=$(echo "$OUR_POSTS" | jq -r '.posts[].id // empty' 2>/dev/null)

    for POST_ID in $OUR_POST_IDS; do
        COMMENTS=$(api_get "/forum/posts/$POST_ID/comments")
        if echo "$COMMENTS" | jq -e '.error' > /dev/null 2>&1; then continue; fi

        echo "$COMMENTS" | jq -c '.comments[]? // empty' 2>/dev/null | while read -r COMMENT; do
            COMMENT_ID=$(echo "$COMMENT" | jq -r '.id')
            AGENT_ID=$(echo "$COMMENT" | jq -r '.agentId // 0')
            AGENT_NAME=$(echo "$COMMENT" | jq -r '.agentName // "unknown"')
            BODY=$(echo "$COMMENT" | jq -r '.body // ""')
            [ "$AGENT_ID" = "$OUR_AGENT_ID" ] && continue

            # Check for compliments with specific feature references (bounty #23)
            if echo "$BODY" | grep -qiE "(impressive|great|amazing|love|brilliant|solid|clever|excellent|well.done).*(VRF|SDK|x402|memory.slot|hitman|Pyth|oracle|audit|PvP|lottery|Jupiter|escrow|PDA)"; then
                if ! already_matched "23" "comment-$COMMENT_ID"; then
                    SNIPPET=$(echo "$BODY" | head -c 120)
                    record_match "23" "$AGENT_NAME" "comment" "$COMMENT_ID" "$SNIPPET"
                    record_match "15" "$AGENT_NAME" "comment" "$COMMENT_ID" "$SNIPPET"
                    record_match "4" "$AGENT_NAME" "comment" "$COMMENT_ID" "$SNIPPET"
                    NEW_MATCHES=$((NEW_MATCHES + 3))
                fi
            # Check for general compliments (bounties #4, #15)
            elif echo "$BODY" | grep -qiE "(impressive|great work|amazing|love (this|what|the)|brilliant|solid work|clever|excellent|well.done|nice work|incredible|respect)"; then
                if ! already_matched "4" "comment-$COMMENT_ID"; then
                    SNIPPET=$(echo "$BODY" | head -c 120)
                    record_match "4" "$AGENT_NAME" "comment" "$COMMENT_ID" "$SNIPPET"
                    record_match "15" "$AGENT_NAME" "comment" "$COMMENT_ID" "$SNIPPET"
                    NEW_MATCHES=$((NEW_MATCHES + 2))
                fi
            fi

            # Check for vote mentions on our posts too
            if echo "$BODY" | grep -qiE "voted|upvoted|have my vote|got my vote"; then
                if ! already_matched "22" "comment-$COMMENT_ID"; then
                    SNIPPET=$(echo "$BODY" | head -c 120)
                    record_match "11" "$AGENT_NAME" "comment" "$COMMENT_ID" "$SNIPPET"
                    record_match "22" "$AGENT_NAME" "comment" "$COMMENT_ID" "$SNIPPET"
                    NEW_MATCHES=$((NEW_MATCHES + 2))
                fi
            fi
        done
        sleep 1
    done
fi
sleep 2

# ── Check 4: Search for "haven't read code" admissions (Bounties #3, #14) ─
log "Check 4: Searching for 'haven't read code' admissions..."
for query in "haven%27t+read+code" "didn%27t+read+code" "without+reading+code" "never+read+the+code"; do
    SEARCH=$(api_get "/forum/search?q=$query&limit=10")
    if echo "$SEARCH" | jq -e '.error' > /dev/null 2>&1; then continue; fi

    for type in posts comments; do
        echo "$SEARCH" | jq -c ".$type[]? // empty" 2>/dev/null | while read -r ITEM; do
            ITEM_ID=$(echo "$ITEM" | jq -r '.id')
            AGENT_ID=$(echo "$ITEM" | jq -r '.agentId // 0')
            AGENT_NAME=$(echo "$ITEM" | jq -r '.agentName // "unknown"')
            BODY=$(echo "$ITEM" | jq -r '.body // ""')
            [ "$AGENT_ID" = "$OUR_AGENT_ID" ] && continue
            if echo "$BODY" | grep -qiE "(I |we |I've |we've ).*(haven't|didn't|never|don't).*(read|look|check|review).*(code|source|repo)"; then
                if ! already_matched "3" "$type-$ITEM_ID"; then
                    SNIPPET=$(echo "$BODY" | head -c 120)
                    record_match "3" "$AGENT_NAME" "$type" "$ITEM_ID" "$SNIPPET"
                    record_match "14" "$AGENT_NAME" "$type" "$ITEM_ID" "$SNIPPET"
                    NEW_MATCHES=$((NEW_MATCHES + 2))
                fi
            fi
        done
    done
    sleep 1
done
sleep 2

# ── Check 5: On-chain PvP challenges from other wallets (Bounties #8, #16, #24) ─
log "Check 5: Checking on-chain PvP challenges..."
PVP_OUTPUT=$(cd "$PROJECT_DIR" && ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
    ANCHOR_WALLET=/root/.config/solana/id.json \
    npx ts-node scripts/pvp-list-challenges.ts 2>&1 || echo "SCRIPT_ERROR")

# Look for challenges NOT from our wallet
EXTERNAL_CHALLENGES=$(echo "$PVP_OUTPUT" | grep -A5 "OPEN\|PENDING" | grep "Challenger:" | grep -v "$OUR_WALLET" || true)
if [ -n "$EXTERNAL_CHALLENGES" ]; then
    log "  FOUND external PvP challenges!"
    echo "$EXTERNAL_CHALLENGES" | while read -r line; do
        CHALLENGER=$(echo "$line" | sed 's/.*Challenger: //')
        if ! already_matched "8" "pvp-$CHALLENGER"; then
            record_match "8" "$CHALLENGER" "on-chain" "pvp-$CHALLENGER" "External PvP challenge created"
            record_match "16" "$CHALLENGER" "on-chain" "pvp-$CHALLENGER" "External PvP challenge created"
            record_match "24" "$CHALLENGER" "on-chain" "pvp-$CHALLENGER" "External PvP challenge created"
            NEW_MATCHES=$((NEW_MATCHES + 3))
        fi
    done
else
    log "  No external PvP challenges found"
fi

# ── Check 6: Targeted agent activity ─
log "Check 6: Checking targeted agent bounties..."

# Search for @Ziggy betting against WARGAMES signals (Bounties #7, #17, #25)
SEARCH=$(api_get "/forum/search?q=Ziggy+bet+against+wargames&limit=10")
if ! echo "$SEARCH" | jq -e '.error' > /dev/null 2>&1; then
    echo "$SEARCH" | jq -c '.comments[]? // empty' 2>/dev/null | while read -r COMMENT; do
        AGENT_NAME=$(echo "$COMMENT" | jq -r '.agentName // "unknown"')
        if echo "$AGENT_NAME" | grep -qi "ziggy"; then
            COMMENT_ID=$(echo "$COMMENT" | jq -r '.id')
            BODY=$(echo "$COMMENT" | jq -r '.body // ""')
            if echo "$BODY" | grep -qiE "bet.*(against|contradict|opposite).*signal|against.*my.*own"; then
                if ! already_matched "7" "comment-$COMMENT_ID"; then
                    SNIPPET=$(echo "$BODY" | head -c 120)
                    record_match "7" "Ziggy" "comment" "$COMMENT_ID" "$SNIPPET"
                    record_match "17" "Ziggy" "comment" "$COMMENT_ID" "$SNIPPET"
                    record_match "25" "Ziggy" "comment" "$COMMENT_ID" "$SNIPPET"
                    NEW_MATCHES=$((NEW_MATCHES + 3))
                fi
            fi
        fi
    done
fi
sleep 1

# Search for agent disagreements (Bounties #10, #21, #29)
log "Check 7: Searching for agent disagreements..."
for query in "disagree" "wrong+about" "actually+incorrect" "debate"; do
    SEARCH=$(api_get "/forum/search?q=$query&limit=10")
    if echo "$SEARCH" | jq -e '.error' > /dev/null 2>&1; then continue; fi

    # Look for posts with high comment counts (indicates back-and-forth)
    echo "$SEARCH" | jq -c '.posts[]? | select(.commentCount >= 6) // empty' 2>/dev/null | while read -r POST; do
        POST_ID=$(echo "$POST" | jq -r '.id')
        AGENT_NAME=$(echo "$POST" | jq -r '.agentName // "unknown"')
        COMMENT_COUNT=$(echo "$POST" | jq -r '.commentCount // 0')
        TITLE=$(echo "$POST" | jq -r '.title // ""')
        [ "$(echo "$POST" | jq -r '.agentId // 0')" = "$OUR_AGENT_ID" ] && continue

        if echo "$TITLE" | grep -qiE "disagree|debate|wrong|challenge|versus|vs\b"; then
            if ! already_matched "10" "post-$POST_ID"; then
                record_match "10" "$AGENT_NAME" "post" "$POST_ID" "Potential disagreement thread ($COMMENT_COUNT comments): $TITLE"
                NEW_MATCHES=$((NEW_MATCHES + 1))
            fi
        fi
    done
    sleep 1
done

# ── Cleanup ───────────────────────────────────────────────────────

# Update last run
TMP=$(mktemp)
jq ".last_run = \"$(date -Iseconds)\"" "$STATE_FILE" > "$TMP" && mv "$TMP" "$STATE_FILE"

# Trim state (keep last 1000 entries)
TMP=$(mktemp)
jq '.seen_comment_ids = (.seen_comment_ids | .[-1000:]) | .seen_post_ids = (.seen_post_ids | .[-1000:])' \
    "$STATE_FILE" > "$TMP" && mv "$TMP" "$STATE_FILE"

# Summary
TOTAL_RECORDED=$(jq '.matches | length' "$MATCHES_FILE")
log "═══ BOUNTY CHECKER COMPLETE — $TOTAL_RECORDED total matches recorded ═══"
log ""
