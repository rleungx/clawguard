---
name: clawguard-install
description: Install, configure, update, and start clawguard for OpenClaw.
---

# clawguard install

Use this skill when the user wants clawguard installed or updated and ready to run as an OpenClaw node host.

## Goal

End with a working `clawguard` install, a real config file, a successful startup or a precise blocker, and the next OpenClaw command the user should run.

## Install or update

Always use the package-style flow:

```bash
npm install -g git+https://github.com/rleungx/clawguard.git
```

Do not clone the repo unless you are debugging the package itself.

## Token

If `OPENCLAW_GATEWAY_TOKEN` is missing, ask the user for it.

```bash
export OPENCLAW_GATEWAY_TOKEN=<your-token>
test -n "$OPENCLAW_GATEWAY_TOKEN"
```

## Config

Create a user-owned config file if one does not already exist:

```bash
mkdir -p ~/.config/clawguard
clawguard init-config --config ~/.config/clawguard/config.json
```

Only overwrite the config if the user explicitly wants to refresh it:

```bash
clawguard init-config --config ~/.config/clawguard/config.json --force
```

Inspect the effective config before startup:

```bash
clawguard print-config --config ~/.config/clawguard/config.json
```

If the machine is remote or cloud-hosted, explicitly verify that `gateway.url` is reachable from that machine.

## Start

```bash
clawguard run --config ~/.config/clawguard/config.json
```

Success looks like a log line showing the node connected to the gateway.

If startup fails, report the exact blocker. The common ones are:

- missing `OPENCLAW_GATEWAY_TOKEN`
- unreachable `gateway.url`
- gateway handshake or auth rejection
- policy or config issues

## Optional macOS background service

Use this only when the user wants clawguard to stay connected without an interactive terminal.

```bash
mkdir -p ~/.config/clawguard ~/.clawguard/logs ~/Library/LaunchAgents
CLAWGUARD_BIN="$(command -v clawguard)"
test -n "$CLAWGUARD_BIN"
cat > ~/Library/LaunchAgents/com.clawguard.agent.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.clawguard.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN" "$CLAWGUARD_BIN" run --config "$HOME/.config/clawguard/config.json"</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$HOME/.config/clawguard</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/.clawguard/logs/launchd.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.clawguard/logs/launchd.stderr.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.clawguard.agent.plist 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.clawguard.agent.plist
launchctl kickstart -k "gui/$(id -u)/com.clawguard.agent"
```

Notes:

- `$HOME` and `OPENCLAW_GATEWAY_TOKEN` are expanded when the plist is written.
- The resulting plist contains the resolved token on disk; treat it as sensitive local config.

Verify with:

```bash
launchctl print "gui/$(id -u)/com.clawguard.agent"
tail -n 50 ~/.clawguard/logs/launchd.stderr.log
tail -n 50 ~/.clawguard/logs/launchd.stdout.log
```

## Optional Linux background service

Use this only when the user wants clawguard to stay connected without an interactive terminal and the machine provides a working `systemd --user` session.

```bash
mkdir -p ~/.config/clawguard ~/.clawguard/logs ~/.config/systemd/user
CLAWGUARD_BIN="$(command -v clawguard)"
test -n "$CLAWGUARD_BIN"
cat > ~/.config/clawguard/clawguard.env <<EOF
OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN
EOF
chmod 600 ~/.config/clawguard/clawguard.env
cat > ~/.config/systemd/user/clawguard.service <<EOF
[Unit]
Description=clawguard OpenClaw node host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/.config/clawguard
EnvironmentFile=%h/.config/clawguard/clawguard.env
ExecStart=/bin/sh -lc '"$CLAWGUARD_BIN" run --config "$HOME/.config/clawguard/config.json"'
Restart=always
RestartSec=5
StandardOutput=append:%h/.clawguard/logs/systemd.stdout.log
StandardError=append:%h/.clawguard/logs/systemd.stderr.log

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now clawguard.service
```

Verify with:

```bash
systemctl --user status clawguard.service --no-pager
journalctl --user -u clawguard.service -n 50 --no-pager
tail -n 50 ~/.clawguard/logs/systemd.stderr.log
tail -n 50 ~/.clawguard/logs/systemd.stdout.log
```

## After startup

Tell the user to finish the OpenClaw side with:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw nodes status
openclaw config set tools.exec.host node
openclaw config set tools.exec.node clawguard-node
```

## Final handoff

End with a short status block:

- install or update succeeded or failed
- config file created or reused
- startup succeeded or the exact blocker
- whether gateway connectivity was confirmed
- what the user should run next in OpenClaw
