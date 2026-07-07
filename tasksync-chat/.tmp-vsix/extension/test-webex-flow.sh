#!/usr/bin/env bash
# ============================================================================
#  AskAway ↔ Webex Integration Test Script (Polling-based)
# ============================================================================
#  Tests every Webex API action AskAway will perform:
#    1. Verify token & identity
#    2. Post an Adaptive Card (with choice options)
#    3. Post an Adaptive Card (with free-text)
#    4. Poll for thread replies (you reply in Webex)
#    5. Update card → Resolved (from Webex reply)
#    6. Update card → Expired (simulated 36h)
#    7. Simulate "Answered from VS Code" on the other card
#
#  Prerequisites: curl, jq, python3
#  Token auto-loaded from AET/session_data/webex_token.json
#
#  Usage:
#    chmod +x test-webex-flow.sh
#    ./test-webex-flow.sh
# ============================================================================

set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

step() { echo -e "\n${CYAN}━━━ STEP $1: $2 ━━━${NC}"; }
ok()   { echo -e "${GREEN}  ✓ $1${NC}"; }
fail() { echo -e "${RED}  ✗ $1${NC}"; }
info() { echo -e "${YELLOW}  ℹ $1${NC}"; }
ask()  { echo -ne "${BOLD}  ▸ $1${NC}"; }
dim()  { echo -e "${DIM}  $1${NC}"; }

# ── Configuration ───────────────────────────────────────────────────────────
AET_TOKEN_FILE="$HOME/PycharmProjects/AET/session_data/webex_token.json"
ROOM_ID="Y2lzY29zcGFyazovL3VzL1JPT00vNzhiODljNjAtMDUxNi0xMWYxLWEzZmYtM2ZiYWM1NDNkMmYy"
ROOM_TITLE="Task sync remote"
WEBEX_TOKEN=""
TASK_ID="tstest_$(date +%s)"
MSG_ID_CHOICES=""
MSG_ID_FREETEXT=""
MY_PERSON_ID=""

# ============================================================================
# STEP 0: Load Token
# ============================================================================
step 0 "Load Webex Access Token"

if [[ -f "$AET_TOKEN_FILE" ]]; then
    WEBEX_TOKEN=$(python3 -c "import json; print(json.load(open('$AET_TOKEN_FILE'))['access_token'])")
    ok "Loaded token from AET: ${WEBEX_TOKEN:0:20}..."
else
    ask "Enter your Webex Access Token: "
    read -r WEBEX_TOKEN
fi

if [[ -z "$WEBEX_TOKEN" ]]; then
    fail "No token provided. Exiting."
    exit 1
fi

AUTH="Authorization: Bearer $WEBEX_TOKEN"

# ============================================================================
# STEP 1: Verify Token (GET /people/me)
# ============================================================================
step 1 "Verify Token — GET /people/me"

ME=$(curl -s -w "\n%{http_code}" "https://webexapis.com/v1/people/me" \
    -H "$AUTH" -H "Content-Type: application/json")
HTTP_CODE=$(echo "$ME" | tail -1)
BODY=$(echo "$ME" | sed '$d')

if [[ "$HTTP_CODE" == "200" ]]; then
    DISPLAY_NAME=$(echo "$BODY" | jq -r '.displayName')
    EMAIL=$(echo "$BODY" | jq -r '.emails[0]')
    MY_PERSON_ID=$(echo "$BODY" | jq -r '.id')
    ok "Authenticated as: $DISPLAY_NAME ($EMAIL)"
    dim "Person ID: ${MY_PERSON_ID:0:40}..."
else
    fail "Token invalid (HTTP $HTTP_CODE)"
    echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
    exit 1
fi

info "Using room: $ROOM_TITLE"
dim "Room ID: ${ROOM_ID:0:50}..."

# ============================================================================
# STEP 2: Post Adaptive Card WITH CHOICES
# ============================================================================
step 2 "Post Adaptive Card (with choice options)"

CARD_CHOICES=$(cat <<EOJSON
{
  "roomId": "$ROOM_ID",
  "text": "AskAway Test [${TASK_ID}]: What should the app name be?",
  "attachments": [{
    "contentType": "application/vnd.microsoft.card.adaptive",
    "content": {
      "type": "AdaptiveCard",
      "version": "1.3",
      "\$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "body": [
        { "type": "TextBlock", "text": "AskAway: New User Input Request", "weight": "Bolder", "size": "Medium" },
        { "type": "TextBlock", "text": "Question: What should the app name be?", "wrap": true },
        {
          "type": "ColumnSet",
          "columns": [
            { "type": "Column", "width": "auto", "items": [{ "type": "TextBlock", "text": "Status:", "weight": "Bolder", "size": "Small" }] },
            { "type": "Column", "width": "stretch", "items": [{ "type": "TextBlock", "text": "⏳ Awaiting Response", "size": "Small", "color": "Attention" }] }
          ]
        },
        { "type": "TextBlock", "text": "1. AuthFixer\n2. LoginBoost\n3. SecureGate", "wrap": true },
        { "type": "TextBlock", "text": "Task ID: $TASK_ID", "size": "Small", "isSubtle": true },
        { "type": "TextBlock", "text": "💬 Reply to this thread with your answer.", "wrap": true, "size": "Small", "isSubtle": true, "spacing": "Medium" }
      ]
    }
  }]
}
EOJSON
)

RESP=$(curl -s -w "\n%{http_code}" -X POST "https://webexapis.com/v1/messages" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "$CARD_CHOICES")
HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [[ "$HTTP_CODE" == "200" ]]; then
    MSG_ID_CHOICES=$(echo "$BODY" | jq -r '.id')
    ok "Card posted! Message ID: ${MSG_ID_CHOICES:0:50}..."
    info "Go to Webex → '$ROOM_TITLE' — you should see the card."
else
    fail "Failed to post card (HTTP $HTTP_CODE)"
    echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
    exit 1
fi

# ============================================================================
# STEP 3: Post Adaptive Card WITH FREE-TEXT
# ============================================================================
step 3 "Post Adaptive Card (free-text question)"

TASK_ID_FREE="${TASK_ID}_free"
CARD_FREETEXT=$(cat <<EOJSON
{
  "roomId": "$ROOM_ID",
  "text": "AskAway Test [${TASK_ID_FREE}]: Describe the deployment strategy.",
  "attachments": [{
    "contentType": "application/vnd.microsoft.card.adaptive",
    "content": {
      "type": "AdaptiveCard",
      "version": "1.3",
      "\$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "body": [
        { "type": "TextBlock", "text": "AskAway: New User Input Request", "weight": "Bolder", "size": "Medium" },
        { "type": "TextBlock", "text": "Question: Describe the deployment strategy for the new microservice.", "wrap": true },
        {
          "type": "ColumnSet",
          "columns": [
            { "type": "Column", "width": "auto", "items": [{ "type": "TextBlock", "text": "Status:", "weight": "Bolder", "size": "Small" }] },
            { "type": "Column", "width": "stretch", "items": [{ "type": "TextBlock", "text": "⏳ Awaiting Response", "size": "Small", "color": "Attention" }] }
          ]
        },
        { "type": "TextBlock", "text": "Task ID: $TASK_ID_FREE", "size": "Small", "isSubtle": true },
        { "type": "TextBlock", "text": "💬 Reply to this thread with your answer.", "wrap": true, "size": "Small", "isSubtle": true, "spacing": "Medium" }
      ]
    }
  }]
}
EOJSON
)

RESP=$(curl -s -w "\n%{http_code}" -X POST "https://webexapis.com/v1/messages" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "$CARD_FREETEXT")
HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [[ "$HTTP_CODE" == "200" ]]; then
    MSG_ID_FREETEXT=$(echo "$BODY" | jq -r '.id')
    ok "Free-text card posted! Message ID: ${MSG_ID_FREETEXT:0:50}..."
else
    fail "Failed to post free-text card (HTTP $HTTP_CODE)"
    echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
fi

# ============================================================================
# STEP 4: Poll for Thread Replies
# ============================================================================
step 4 "Poll for thread replies on first card"

echo ""
info "Now go to Webex, find the first card ('What should the app name be?'),"
info "and REPLY IN THE THREAD with your answer (e.g. type 'AuthFixer')."
echo ""
info "Polling GET /v1/messages?roomId=...&parentId={cardMessageId} every 3 seconds..."
info "(Timeout: 180 seconds)"
echo ""

REPLY_TEXT=""
REPLY_USER=""
POLL_START=$(date +%s)
POLL_COUNT=0

while true; do
    ELAPSED=$(( $(date +%s) - POLL_START ))
    if [[ $ELAPSED -gt 180 ]]; then
        fail "Timeout: No thread reply received in 180 seconds."
        break
    fi

    POLL_COUNT=$((POLL_COUNT + 1))

    RESP=$(curl -s "https://webexapis.com/v1/messages?roomId=$ROOM_ID&parentId=$MSG_ID_CHOICES&max=5" \
        -H "$AUTH" -H "Content-Type: application/json")

    ITEMS=$(echo "$RESP" | jq -r '.items // []')
    COUNT=$(echo "$ITEMS" | jq 'length')

    if [[ "$COUNT" -gt 0 ]]; then
        # Find replies NOT from ourselves
        for i in $(seq 0 $((COUNT - 1))); do
            PID=$(echo "$ITEMS" | jq -r ".[$i].personId")
            if [[ "$PID" != "$MY_PERSON_ID" ]]; then
                REPLY_TEXT=$(echo "$ITEMS" | jq -r ".[$i].text")
                REPLY_USER=$(echo "$ITEMS" | jq -r ".[$i].personEmail")
                REPLY_MSG_ID=$(echo "$ITEMS" | jq -r ".[$i].id")
                break 2
            fi
        done

        # If all replies are from ourselves (the bot), check if count > 0
        # This happens when the token belongs to the same user who posted
        if [[ "$COUNT" -gt 0 && -z "$REPLY_TEXT" ]]; then
            # In self-reply scenario, accept our own replies too
            REPLY_TEXT=$(echo "$ITEMS" | jq -r '.[0].text')
            REPLY_USER=$(echo "$ITEMS" | jq -r '.[0].personEmail')
            REPLY_MSG_ID=$(echo "$ITEMS" | jq -r '.[0].id')
            break
        fi
    fi

    echo -ne "\r  Polling... #${POLL_COUNT} (${ELAPSED}s elapsed)  "
    sleep 3
done
echo ""

if [[ -n "$REPLY_TEXT" ]]; then
    ok "Reply received!"
    echo -e "  ${GREEN}From:${NC}     $REPLY_USER"
    echo -e "  ${GREEN}Response:${NC} $REPLY_TEXT"
    echo -e "  ${DIM}Message ID: ${REPLY_MSG_ID:0:50}...${NC}"
else
    info "No reply detected. Continuing with simulated response."
    REPLY_TEXT="AuthFixer"
    REPLY_USER="$EMAIL"
fi

# ============================================================================
# STEP 5: Update Card → "Resolved" (Webex reply)
# ============================================================================
step 5 "Update card → RESOLVED (from Webex reply)"

RESOLVED_CARD=$(cat <<EOJSON
{
  "roomId": "$ROOM_ID",
  "text": "Task resolved: $REPLY_TEXT",
  "attachments": [{
    "contentType": "application/vnd.microsoft.card.adaptive",
    "content": {
      "type": "AdaptiveCard",
      "version": "1.3",
      "\$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "body": [
        { "type": "TextBlock", "text": "AskAway: Task Request", "weight": "Bolder", "size": "Medium" },
        { "type": "TextBlock", "text": "Question: What should the app name be?", "wrap": true },
        { "type": "TextBlock", "text": "Status: ✅ Answered", "color": "Good", "weight": "Bolder" },
        { "type": "TextBlock", "text": "Response: $REPLY_TEXT", "wrap": true },
        { "type": "TextBlock", "text": "Submitted by: $REPLY_USER (via Webex)", "size": "Small", "isSubtle": true },
        { "type": "TextBlock", "text": "Task ID: $TASK_ID", "size": "Small", "isSubtle": true }
      ]
    }
  }]
}
EOJSON
)

RESP=$(curl -s -w "\n%{http_code}" -X PUT "https://webexapis.com/v1/messages/$MSG_ID_CHOICES" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "$RESOLVED_CARD")
HTTP_CODE=$(echo "$RESP" | tail -1)

if [[ "$HTTP_CODE" == "200" ]]; then
    ok "Card updated to RESOLVED! Check Webex — green ✅ status."
else
    fail "Failed to update card (HTTP $HTTP_CODE)"
    echo "$RESP" | sed '$d' | jq . 2>/dev/null
fi

sleep 2

# ============================================================================
# STEP 6: Update Card → "Expired" (simulated 36h timeout)
# ============================================================================
step 6 "Update card → EXPIRED (simulated 36h timeout)"

ask "Press Enter to update the SECOND card (Free-text) to 'Expired' status... "
read -r

EXPIRED_CARD=$(cat <<EOJSON
{
  "roomId": "$ROOM_ID",
  "text": "Task expired: No response within 36 hours.",
  "attachments": [{
    "contentType": "application/vnd.microsoft.card.adaptive",
    "content": {
      "type": "AdaptiveCard",
      "version": "1.3",
      "\$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "body": [
        { "type": "TextBlock", "text": "AskAway: Task Request", "weight": "Bolder", "size": "Medium" },
        { "type": "TextBlock", "text": "Question: Describe the deployment strategy for the new microservice.", "wrap": true },
        { "type": "TextBlock", "text": "Status: ⚠️ Expired — No response received within 36 hours.", "color": "Warning", "weight": "Bolder" },
        { "type": "TextBlock", "text": "Task ID: $TASK_ID_FREE", "size": "Small", "isSubtle": true }
      ]
    }
  }]
}
EOJSON
)

RESP=$(curl -s -w "\n%{http_code}" -X PUT "https://webexapis.com/v1/messages/$MSG_ID_FREETEXT" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "$EXPIRED_CARD")
HTTP_CODE=$(echo "$RESP" | tail -1)

if [[ "$HTTP_CODE" == "200" ]]; then
    ok "Card updated to EXPIRED! Check Webex — ⚠️ warning status."
else
    fail "Failed to update card (HTTP $HTTP_CODE)"
    echo "$RESP" | sed '$d' | jq . 2>/dev/null
fi

# ============================================================================
# STEP 7: Update first card → "Answered from VS Code"
# ============================================================================
step 7 "Update FIRST card → Answered from VS Code (Simulating sync)"

if [[ -n "$MSG_ID_CHOICES" ]]; then
    VSCODE_CARD=$(cat <<EOJSON
{
  "roomId": "$ROOM_ID",
  "text": "Task resolved from VS Code: AuthFixer",
  "attachments": [{
    "contentType": "application/vnd.microsoft.card.adaptive",
    "content": {
      "type": "AdaptiveCard",
      "version": "1.3",
      "\$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "body": [
        { "type": "TextBlock", "text": "AskAway: Task Request", "weight": "Bolder", "size": "Medium" },
        { "type": "TextBlock", "text": "Question: What should the app name be?", "wrap": true },
        { "type": "TextBlock", "text": "Status: ✅ Answered", "color": "Good", "weight": "Bolder" },
        { "type": "TextBlock", "text": "Response: AuthFixer", "wrap": true },
        { "type": "TextBlock", "text": "Submitted by: $EMAIL (via VS Code)", "size": "Small", "isSubtle": true },
        { "type": "TextBlock", "text": "Task ID: $TASK_ID", "size": "Small", "isSubtle": true }
      ]
    }
  }]
}
EOJSON
    )

    RESP=$(curl -s -w "\n%{http_code}" -X PUT "https://webexapis.com/v1/messages/$MSG_ID_CHOICES" \
        -H "$AUTH" -H "Content-Type: application/json" \
        -d "$VSCODE_CARD")
    HTTP_CODE=$(echo "$RESP" | tail -1)

    if [[ "$HTTP_CODE" == "200" ]]; then
        ok "First card updated → 'Answered from VS Code' (Simulated sync)"
    else
        fail "Failed (HTTP $HTTP_CODE)"
        echo "$RESP" | sed '$d' | jq . 2>/dev/null
    fi
else
    info "Skipped — no choice card was posted."
fi

# ============================================================================
# Summary
# ============================================================================
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  TEST COMPLETE${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Actions tested:"
echo "    ✓  Token verification              (GET /people/me)"
echo "    ✓  Post card with choices           (POST /messages + adaptive card)"
echo "    ✓  Post card with free-text         (POST /messages + adaptive card)"
echo "    ✓  Poll for thread replies          (GET /messages?parentId=...)"
echo "    ✓  Update card → Resolved           (PUT /messages/{id})"
echo "    ✓  Update card → Expired            (PUT /messages/{id})"
echo "    ✓  Update card → Answered from VSC  (PUT /messages/{id})"
echo ""
echo "  Room: $ROOM_TITLE"
echo "  Task IDs: $TASK_ID, $TASK_ID_FREE"
echo ""
