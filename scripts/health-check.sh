#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
CFG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_DIR/openclaw.json}"
LOG_PATH="${XCHAT_LOG_PATH:-$OPENCLAW_DIR/xchat/orchestrator.log}"

pass() { printf '[PASS] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; }
fail() { printf '[FAIL] %s\n' "$*"; }

has_fail=0

if [[ -f "$CFG_PATH" ]]; then
  if jq -e '.agents.list[]? | has("bindings")' "$CFG_PATH" >/dev/null 2>&1; then
    fail "Invalid key detected: agents.list[*].bindings exists in $CFG_PATH"
    has_fail=1
  else
    pass "OpenClaw config schema check passed (no agents.list[*].bindings)"
  fi
else
  fail "Config file missing: $CFG_PATH"
  has_fail=1
fi

if openclaw gateway status | rg -q 'Runtime: running'; then
  pass "OpenClaw gateway runtime is running"
else
  fail "OpenClaw gateway runtime is NOT running"
  has_fail=1
fi

if openclaw gateway status | rg -q 'RPC probe: ok'; then
  pass "OpenClaw RPC probe is OK"
else
  fail "OpenClaw RPC probe is NOT OK"
  has_fail=1
fi

if launchctl list | rg -q 'com.openclaw.xchat.orchestrator'; then
  pass "LaunchAgent com.openclaw.xchat.orchestrator is loaded"
else
  fail "LaunchAgent com.openclaw.xchat.orchestrator is NOT loaded"
  has_fail=1
fi

if pgrep -f 'orchestrator.mjs' >/dev/null 2>&1; then
  pass "orchestrator.mjs process is running"
else
  fail "orchestrator.mjs process is NOT running"
  has_fail=1
fi

for label in com.clawdbot-deepseek.gateway com.clawdbot-glm.gateway; do
  if launchctl list | rg -q "$label"; then
    pass "$label is loaded"
  else
    warn "$label is not loaded"
  fi
done

if [[ -f "$LOG_PATH" ]]; then
  last_connected="$(rg 'connected gateways:' "$LOG_PATH" | tail -n 1 || true)"
  if [[ -n "$last_connected" ]]; then
    pass "Latest gateway-connect marker found in log"
    printf '      %s\n' "$last_connected"
  else
    warn "No 'connected gateways' marker found in $LOG_PATH yet"
  fi
else
  warn "xchat log file not found: $LOG_PATH"
fi

if [[ "$has_fail" -ne 0 ]]; then
  printf '\nHealth check result: FAILED\n'
  exit 1
fi

printf '\nHealth check result: OK\n'
