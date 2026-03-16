# clawguard

`clawguard` is a small OpenClaw-compatible node host that puts a local policy and approval layer in front of `system.run`.

## One prompt

If you want OpenClaw to install and run it for you, paste this:

```text
Read https://raw.githubusercontent.com/rleungx/clawguard/main/SKILL.md and follow the instructions to install and configure clawguard for OpenClaw.
```

## Quick start

```bash
git clone git@github.com:rleungx/clawguard.git
cd clawguard
npm install
export OPENCLAW_GATEWAY_TOKEN=your-token
node ./bin/clawguard.js print-config --config ./examples/clawguard.config.json
node ./bin/clawguard.js run --config ./examples/clawguard.config.json
```

## What it exposes

- `system.run`
- `system.which`
- `system.execApprovals.get`
- `system.execApprovals.set`

Every command goes through:

- local JSON policy rules
- local approval allowlist
- optional local TTY approval prompt
- JSONL audit logging

## Minimal OpenClaw flow

After `clawguard` is running:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw nodes status
openclaw config set tools.exec.host node
openclaw config set tools.exec.node clawguard-node
```

## Example config

The included config lives at `examples/clawguard.config.json`.

```json
{
  "gateway": {
    "url": "ws://127.0.0.1:18789",
    "tokenEnv": "OPENCLAW_GATEWAY_TOKEN",
    "reconnectMs": 3000,
    "openTimeoutMs": 10000,
    "eventTimeoutMs": 10000,
    "requestTimeoutMs": 15000,
    "handshakeProfile": "auto"
  },
  "storage": {
    "dir": "../.clawguard"
  },
  "audit": {
    "path": "../.clawguard/audit.jsonl"
  },
  "logging": {
    "level": "info"
  },
  "approvals": {
    "path": "../.clawguard/exec-approvals.json",
    "askMode": "tty",
    "askFallback": "deny",
    "askTimeoutMs": 300000
  },
  "node": {
    "displayName": "clawguard-node",
    "browserToolsEnabled": false,
    "browserProxyEnabled": false
  },
  "runner": {
    "defaultCwd": "..",
    "maxOutputBytes": 1048576
  },
  "policy": {
    "defaultAction": "deny",
    "allowShellText": false,
    "denyPaths": [
      "~/.ssh/**",
      "~/.aws/**",
      "~/.openclaw/**"
    ],
    "commandRules": [
      {
        "id": "allow-git-readonly",
        "action": "allow",
        "match": {
          "binary": [
            "/usr/bin/git",
            "/opt/homebrew/bin/git"
          ],
          "argvIncludes": [
            "status"
          ]
        },
        "cwd": [
          "../**"
        ]
      },
      {
        "id": "allow-node-test",
        "action": "allow",
        "match": {
          "binary": [
            "/usr/bin/node",
            "/Users/rleungx/.nvm/versions/node/v22.22.1/bin/node"
          ],
          "argvIncludes": [
            "--test"
          ]
        },
        "cwd": [
          "../**"
        ]
      }
    ]
  }
}
```

## Useful knobs

- `gateway.handshakeProfile`: `auto`, `modern`, or `legacy`
- `gateway.openTimeoutMs`: websocket open timeout
- `gateway.eventTimeoutMs`: handshake/event wait timeout
- `gateway.requestTimeoutMs`: request/response timeout
- `runner.maxOutputBytes`: per-stream output cap
- `approvals.askTimeoutMs`: local prompt timeout
- `logging.level`: `silent`, `error`, or `info`

## Development

```bash
npm test
```
