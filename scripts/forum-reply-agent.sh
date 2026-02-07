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
MAX_REPLIES_PER_RUN=6   # Stay well under 30/hr rate limit
REPLY_COUNT=0

# Spam bots to ignore
SPAM_BOTS="Sipher|Mereum|ClaudeCraft|neptu|IBRL-agent"

# Our post IDs (all 37+ posts)
POST_IDS=(426 429 434 437 446 502 506 508 509 511 524 550 558 559 561 762 765 786 797 803 815 817 827 841 852 870 877 882 886 975 976 1009 1010 1641 1645 1652 1659 1896 2153)

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

# Generate a reply using Claude CLI
generate_reply() {
    local context="$1"
    local reply
    reply=$(claude -p --model haiku --no-session-persistence --tools "" \
        --system-prompt "You write forum replies for Claude-the-Romulan, an AI agent in the Colosseum Agent Hackathon (Feb 2-12, 2026). Your project is Agent Casino — a headless casino protocol on Solana. 4 provably fair games, Switchboard VRF, PvP, memory slots, hitman market, Pyth predictions, x402 API, Jupiter swap. 4 audits, 55 bugs fixed, 69 tests. 100% AI-built.

OUTPUT FORMAT: Output ONLY the reply text. Nothing else. No explanations, no commentary, no markdown formatting, no bullet points about what you did. Just the reply exactly as it should be posted.

REPLY RULES:
- ALWAYS start with @AgentName (the agent you're replying to)
- Be friendly, genuine, substantive — no empty praise
- 2-4 sentences max. Conversational, not formal
- If they asked a question, answer it specifically
- If relevant, briefly mention Agent Casino but don't be pushy
- 1-2 emojis max
- Date: $(date +%Y-%m-%d)" \
        "$context" 2>/dev/null)
    echo "$reply"
}

# ── Main Logic ────────────────────────────────────────────────────
log "═══ FORUM REPLY AGENT START ═══"

# ── Phase 1: Reply to unreplied comments on our posts ─────────
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

        log "Replying to $AGENT_NAME on post #$POST_ID ($POST_TITLE)"
        log "  Comment: ${COMMENT_BODY:0:100}..."

        # Generate reply
        CONTEXT="Reply to this comment on our forum post titled \"$POST_TITLE\":

Agent name: $AGENT_NAME
Their comment: $COMMENT_BODY

Our post is about Agent Casino. Generate a friendly, substantive reply. Start with @$AGENT_NAME"

        REPLY=$(generate_reply "$CONTEXT")

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

log "Phase 1 complete: $REPLY_COUNT replies sent"

# ── Phase 2: Engage with hot posts we haven't commented on ────
if [ "$REPLY_COUNT" -lt "$MAX_REPLIES_PER_RUN" ]; then
    log "Phase 2: Checking hot posts for engagement opportunities..."

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

            log "Engaging with hot post #$POST_ID by $POST_AGENT_NAME: $POST_TITLE"

            # Generate engagement comment
            CONTEXT="Write a comment on this hackathon forum post by another agent:

Post author: $POST_AGENT_NAME
Post title: $POST_TITLE
Post body (first 500 chars): ${POST_BODY:0:500}

Write a genuine, helpful comment. Start with @$POST_AGENT_NAME. Be substantive — ask a specific question, share a relevant insight, or offer to collaborate. If their project could integrate with Agent Casino (on-chain games, SDK, VRF), mention it briefly."

            REPLY=$(generate_reply "$CONTEXT")

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

    log "Phase 2 complete"
fi

# Update last run timestamp
TMP=$(mktemp)
jq ".last_run = \"$(date -Iseconds)\"" "$STATE_FILE" > "$TMP" && mv "$TMP" "$STATE_FILE"

# Trim state file if it gets too large (keep last 500 entries)
TMP=$(mktemp)
jq '.replied_comment_ids = (.replied_comment_ids | .[-500:]) | .engaged_post_ids = (.engaged_post_ids | .[-500:])' "$STATE_FILE" > "$TMP" && mv "$TMP" "$STATE_FILE"

log "═══ FORUM REPLY AGENT COMPLETE ($REPLY_COUNT replies this run) ═══"
log ""
