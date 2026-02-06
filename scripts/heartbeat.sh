#!/bin/bash
# Agent Casino Heartbeat Script
# Runs every 30 minutes to check forum activity and monitor hackathon progress

set -e

# Load environment
source "/root/Solana Hackathon/.env"

API_BASE="https://agents.colosseum.com/api"
LOG_FILE="/root/Solana Hackathon/agent-casino/heartbeat.log"

# Our post IDs to monitor (all 37 posts, updated Feb 6)
POST_IDS=(426 429 434 437 446 502 506 508 509 511 524 550 558 559 561 762 765 786 797 803 815 817 827 841 852 870 877 882 886 975 976 1009 1010 1641 1645 1652 1659)

log() {
    echo "[$(date -Iseconds)] $1" >> "$LOG_FILE"
}

log "=== HEARTBEAT START ==="

# 0. Check skill.md version (should be 1.6.0 as of Feb 6)
log "Checking skill.md version..."
SKILL_VERSION=$(curl -s https://colosseum.com/skill.md | head -20 | grep -o "version.*[0-9]\.[0-9]\.[0-9]" | head -1 || echo "unknown")
log "Skill version: $SKILL_VERSION"
if [[ "$SKILL_VERSION" != *"1.6.0"* ]] && [[ "$SKILL_VERSION" != "unknown" ]]; then
    log "WARNING: Skill version may have changed! Re-fetch full skill.md"
fi

# 1. Check agent status
log "Checking agent status..."
STATUS=$(curl -s -H "Authorization: Bearer $COLOSSEUM_API_KEY" "$API_BASE/agents/status" 2>/dev/null || echo '{"error":"failed"}')
if echo "$STATUS" | grep -q "error"; then
    log "WARNING: Could not fetch agent status"
else
    log "Agent status: OK"
fi

# 2. Check for new comments on our posts
log "Checking forum comments..."
NEW_COMMENTS=0
for POST_ID in "${POST_IDS[@]}"; do
    COMMENTS=$(curl -s -H "Authorization: Bearer $COLOSSEUM_API_KEY" "$API_BASE/forum/posts/$POST_ID/comments" 2>/dev/null)
    COUNT=$(echo "$COMMENTS" | jq -r '.totalCount // 0')

    # Check for comments from others (not our own agent ID 307)
    OTHERS=$(echo "$COMMENTS" | jq '[.comments[] | select(.agentId != 307)] | length')

    if [ "$OTHERS" -gt 0 ]; then
        # Get most recent non-self comment
        LATEST=$(echo "$COMMENTS" | jq -r '[.comments[] | select(.agentId != 307)] | sort_by(.createdAt) | last | "\(.agentName): \(.body[0:100])..."')
        log "Post #$POST_ID: $COUNT comments ($OTHERS from others)"
    fi
done

# 3. Check recent forum activity
log "Checking recent forum posts..."
RECENT=$(curl -s -H "Authorization: Bearer $COLOSSEUM_API_KEY" "$API_BASE/forum/posts?sort=new&limit=5" 2>/dev/null)
RECENT_COUNT=$(echo "$RECENT" | jq '.posts | length')
log "Recent posts fetched: $RECENT_COUNT"

# 4. Check leaderboard position
log "Checking leaderboard..."
LEADERBOARD=$(curl -s -H "Authorization: Bearer $COLOSSEUM_API_KEY" "$API_BASE/leaderboard?limit=100" 2>/dev/null)
OUR_ENTRY=$(echo "$LEADERBOARD" | jq -r '.entries[]? | select(.project.name == "agent-casino-protocol") | "rank \(.rank), human: \(.project.humanUpvotes), agent: \(.project.agentUpvotes)"' 2>/dev/null)
if [ -n "$OUR_ENTRY" ]; then
    log "Leaderboard: $OUR_ENTRY"
else
    log "Leaderboard: not in top 100 or could not parse"
fi

# 5. Check prediction market status
log "Checking prediction market..."
cd "/root/Solana Hackathon/agent-casino"
MARKET_STATUS=$(npx ts-node scripts/prediction-view-market.ts AoEUp8smxwe7xdv2dxFA9Pp6wHSbJe2v4NPbwWDfVYK3 2>/dev/null | grep "Total Committed" || echo "Could not fetch")
log "Market: $MARKET_STATUS"

log "=== HEARTBEAT COMPLETE ==="
echo ""
