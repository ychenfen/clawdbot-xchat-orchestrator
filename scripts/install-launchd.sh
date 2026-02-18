#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

LABEL="com.openclaw.xchat.orchestrator"
PLIST_OUT="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/.openclaw/xchat"

NODE_BIN="${NODE_BIN:-$(command -v node)}"
if [[ -z "${NODE_BIN}" ]]; then
  echo "node not found in PATH" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"

cat >"$PLIST_OUT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${NODE_BIN}</string>
      <string>${ROOT_DIR}/src/orchestrator.mjs</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>WorkingDirectory</key>
    <string>${HOME}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>${HOME}</string>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/orchestrator.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/orchestrator.err.log</string>
  </dict>
</plist>
EOF

echo "Wrote: $PLIST_OUT"

launchctl unload "gui/$UID/$LABEL" 2>/dev/null || true
launchctl load "$PLIST_OUT"
launchctl kickstart -k "gui/$UID/$LABEL"

echo "Installed and started: $LABEL"

