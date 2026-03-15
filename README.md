# secure-node

`secure-node` is a small OpenClaw-compatible node host MVP that adds a local policy gate in front of `system.run`.

It is designed for the "safe node host / exec broker" shape:

- OpenClaw keeps handling chat, planning, and tool routing.
- `secure-node` registers as a node and exposes `system.run`, `system.which`, `system.execApprovals.get`, and `system.execApprovals.set`.
- Every incoming command is evaluated against a local policy file and a local approval allowlist before it is executed.

## What this MVP does

- Connects to an OpenClaw Gateway over WebSocket and identifies itself as a node host.
- Persists a local device identity and cached device token.
- Enforces a JSON policy file with `allow` / `ask` / `deny` decisions.
- Enforces a second approval layer using a local `exec-approvals.json` file.
- Supports local TTY prompts for `ask` decisions.
- Writes JSONL audit events for connection, decision, and execution outcomes.

## What this MVP does not do yet

- Gateway-mediated approval broadcast flow.
- Container or VM sandboxing.
- Network isolation.
- Full PTY / background process parity with OpenClaw's richer `exec` modes.
- Browser proxy support.

## Project layout

- `bin/secure-node.js`
- `src/cli.js`
- `src/node-host.js`
- `src/protocol-client.js`
- `src/policy.js`
- `src/approvals-store.js`
- `src/runner.js`

## Usage

1. Export a gateway token:

```bash
export OPENCLAW_GATEWAY_TOKEN=...
```

2. Inspect the effective config:

```bash
node ./bin/secure-node.js print-config --config ./examples/secure-node.config.json
```

3. Run the node host:

```bash
node ./bin/secure-node.js run --config ./examples/secure-node.config.json
```

4. Approve the device from OpenClaw:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw nodes status
```

5. Point execution at the node:

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.node safe-build-node
```

## Config shape

The config file is JSON to keep the MVP dependency-free.

```json
{
  "gateway": {
    "url": "ws://127.0.0.1:18789",
    "tokenEnv": "OPENCLAW_GATEWAY_TOKEN",
    "openTimeoutMs": 10000,
    "eventTimeoutMs": 10000,
    "requestTimeoutMs": 15000
  },
  "node": {
    "displayName": "safe-build-node",
    "browserToolsEnabled": false,
    "browserProxyEnabled": false
  },
  "approvals": {
    "askTimeoutMs": 300000
  },
  "runner": {
    "defaultCwd": ".",
    "maxOutputBytes": 1048576
  },
  "policy": {
    "defaultAction": "deny",
    "allowShellText": false,
    "denyPaths": [
      "~/.ssh/**",
      "~/.aws/**"
    ],
    "commandRules": [
      {
        "id": "allow-git-status",
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
          "./**"
        ]
      }
    ]
  }
}
```

Useful operator knobs:

- `gateway.openTimeoutMs`: fail the initial websocket open if the gateway never accepts the connection.
- `gateway.eventTimeoutMs`: bound waits for challenge/welcome and other protocol events.
- `gateway.requestTimeoutMs`: bound request/response waits such as `connect` and `node.invoke.result`.
- `approvals.askTimeoutMs`: default timeout for local TTY approval prompts.
- `runner.defaultCwd`: base working directory when a run request omits `cwd`.
- `runner.maxOutputBytes`: per-stream output cap for `stdout` and `stderr`.

## Approval file

`system.execApprovals.get` and `system.execApprovals.set` read and write a local JSON file like this:

```json
{
  "version": 1,
  "socket": null,
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "*": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "autoAllowSkills": false,
      "allowlist": [
        {
          "id": "entry-1",
          "pattern": "/usr/bin/git"
        }
      ]
    },
    "ci-agent": {
      "security": "full",
      "ask": "never",
      "askFallback": "deny",
      "autoAllowSkills": false,
      "allowlist": []
    }
  }
}
```

## Development

```bash
npm test
```
