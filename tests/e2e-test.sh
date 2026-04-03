#!/usr/bin/env bash
# QuestWorks E2E Test Suite
set +e

QW="http://10.0.1.13:8788"
TOKEN="fa24fa00c8cb44f108df71008582d5ff7c2e025bd36c7ced3a1e0152fed84bfd"
AUTH="Authorization: Bearer $TOKEN"
PASS=0; FAIL=0; WARN=0

check() {
  local name="$1" expected="$2" actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo "✅ $name"
    ((PASS++))
  else
    echo "❌ $name (expected '$expected', got: $actual)"
    ((FAIL++))
  fi
}

warn_check() {
  local name="$1" expected="$2" actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo "✅ $name"
    ((PASS++))
  else
    echo "⚠️  $name (expected '$expected', got: $actual)"
    ((WARN++))
  fi
}

echo "═══════════════════════════════════════"
echo "  QuestWorks E2E Test Suite"
echo "  Target: $QW"
echo "═══════════════════════════════════════"
echo ""

# T1: Health
echo "--- T1: Health ---"
R=$(curl -s "$QW/health")
check "Health endpoint" '"ok":true' "$R"
check "Postgres backend" '"backend":"postgres"' "$R"
echo "  Response: $R"
echo ""

# T2: Root
echo "--- T2: Root endpoint ---"
R=$(curl -s "$QW/")
check "Root returns service info" '"service":"QuestWorks"' "$R"
echo "  Response: $R"
echo ""

# T3: Status (no /status route in codebase — skipped by design)
echo "--- T3: Status ---"
echo "⏭️  Skipped (no /status route exists)"
echo ""

# T4: Unauthorized without token
echo "--- T4: Auth check ---"
R=$(curl -s "$QW/tasks")
check "Unauthorized without token" '"error":"unauthorized"' "$R"
echo ""

# T5: List adapters
echo "--- T5: List adapters ---"
R=$(curl -s -H "$AUTH" "$QW/adapters")
check "Adapters endpoint returns array" '\[' "$R"
echo "  Response: ${R:0:300}"
ADAPTER_ID=$(echo "$R" | python3 -c "import json,sys; a=json.load(sys.stdin); print(a[0]['id'] if a else 'NONE')" 2>/dev/null || echo "PARSE_FAIL")
echo "  First adapter ID: $ADAPTER_ID"
echo ""

# T6: Adapter detail
echo "--- T6: Adapter detail ---"
if [ "$ADAPTER_ID" != "NONE" ] && [ "$ADAPTER_ID" != "PARSE_FAIL" ]; then
  R=$(curl -s -H "$AUTH" "$QW/adapters/$ADAPTER_ID")
  check "Adapter detail returns id" "$ADAPTER_ID" "$R"
  echo "  Response: ${R:0:300}"
else
  echo "⚠️  Skipped (no adapter found)"
  ((WARN++))
fi
echo ""

# T7: List tasks (before creating any)
echo "--- T7: List tasks (initial) ---"
R=$(curl -s -H "$AUTH" "$QW/tasks")
check "Tasks endpoint returns array" '\[' "$R"
INITIAL_COUNT=$(echo "$R" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?")
echo "  Initial task count: $INITIAL_COUNT"
echo ""

# T8: Create task
echo "--- T8: Create task ---"
R=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" "$QW/tasks" -d '{
  "title": "E2E Test Task",
  "description": "Created by Dottie for end-to-end testing",
  "priority": 2,
  "source": "api"
}')
check "Task created" '"id"' "$R"
TASK_ID=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id','FAIL'))" 2>/dev/null || echo "FAIL")
echo "  Task ID: $TASK_ID"
echo "  Response: ${R:0:300}"
echo ""

# T9: Get task by ID
echo "--- T9: Get task by ID ---"
if [ "$TASK_ID" != "FAIL" ]; then
  R=$(curl -s -H "$AUTH" "$QW/tasks/$TASK_ID")
  check "Task retrieved" '"E2E Test Task"' "$R"
  echo "  Response: ${R:0:300}"
else
  echo "❌ Skipped (no task ID)"
  ((FAIL++))
fi
echo ""

# T10: Update task
echo "--- T10: Update task ---"
if [ "$TASK_ID" != "FAIL" ]; then
  R=$(curl -s -X PATCH -H "$AUTH" -H "Content-Type: application/json" "$QW/tasks/$TASK_ID" -d '{
    "priority": 1,
    "assignee": "drquest"
  }')
  check "Task updated" '"id"' "$R"
  echo "  Response: ${R:0:300}"
else
  echo "❌ Skipped"
  ((FAIL++))
fi
echo ""

# T11: List tasks (should have our new one)
echo "--- T11: List tasks (after create) ---"
R=$(curl -s -H "$AUTH" "$QW/tasks")
check "Tasks list contains our task" 'E2E Test Task' "$R"
echo ""

# T12: Slash command - help (slash handler responds 200 empty, posts async to MM)
echo "--- T12: Slash /qw help ---"
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Content-Type: application/x-www-form-urlencoded" "$QW/slash" \
  -d "user_id=testuser&channel_id=testchan&text=help")
check "Slash help returns 200 (async response via MM)" '200' "$HTTP"
echo ""

# T13: Slash command - task list
echo "--- T13: Slash /qw task list ---"
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Content-Type: application/x-www-form-urlencoded" "$QW/slash" \
  -d "user_id=testuser&channel_id=testchan&text=task%20list")
check "Slash task list returns 200 (async response via MM)" '200' "$HTTP"
echo ""

# T14: Slash command - adapter list
echo "--- T14: Slash /qw adapter list ---"
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Content-Type: application/x-www-form-urlencoded" "$QW/slash" \
  -d "user_id=testuser&channel_id=testchan&text=adapter%20list")
check "Slash adapter list returns 200 (async response via MM)" '200' "$HTTP"
echo ""

# T15: Delete task
echo "--- T15: Delete task ---"
if [ "$TASK_ID" != "FAIL" ]; then
  R=$(curl -s -X DELETE -H "$AUTH" "$QW/tasks/$TASK_ID" 2>&1 || echo "DELETE_ERROR")
  check "Task deleted" 'ok\|deleted\|204\|{}' "$R"
  echo "  Response: ${R:0:200}"
else
  echo "❌ Skipped"
  ((FAIL++))
fi
echo ""

# T16: Confirm deletion
echo "--- T16: Confirm deletion ---"
R=$(curl -s -H "$AUTH" "$QW/tasks")
if echo "$R" | grep -q "E2E Test Task"; then
  echo "❌ Task still exists after delete"
  ((FAIL++))
else
  echo "✅ Task confirmed deleted"
  ((PASS++))
fi
echo ""

# Summary
echo "═══════════════════════════════════════"
echo "  RESULTS: ✅ $PASS passed, ❌ $FAIL failed, ⚠️  $WARN warnings"
echo "═══════════════════════════════════════"
