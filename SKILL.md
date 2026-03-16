---
name: clawguard-install
description: Install, configure, and start clawguard for OpenClaw.
---

# clawguard install

Use this skill when the user wants to:

- install `clawguard`
- set up a local or remote OpenClaw node host
- connect `clawguard` to an OpenClaw Gateway
- run a safe execution broker with local policy and approvals

Do not use this skill for unrelated OpenClaw issues.

## Goal

Get `clawguard` cloned, installed, configured, and running.

## Definition of done

This skill is complete only when all of the following are true:

1. the repo is cloned locally
2. dependencies are installed
3. the effective config is printed successfully
4. `OPENCLAW_GATEWAY_TOKEN` is set or the user is clearly asked for it
5. `clawguard` starts successfully or the exact blocker is reported
6. the user is told the next OpenClaw commands to finish approval / node selection

## Install flow

### Step 1 - Clone the repo

```bash
git clone git@github.com:rleungx/clawguard.git
cd clawguard
```

### Step 2 - Install dependencies

```bash
npm install
```

### Step 3 - Set the gateway token

Ask the user for the token if it is not already present.

```bash
export OPENCLAW_GATEWAY_TOKEN=<your-token>
```

### Step 4 - Inspect the effective config

```bash
node ./bin/clawguard.js print-config --config ./examples/clawguard.config.json
```

If the user is on a cloud machine or remote box, explicitly check whether `gateway.url` is reachable from that machine.

### Step 5 - Start clawguard

```bash
node ./bin/clawguard.js run --config ./examples/clawguard.config.json
```

Success looks like a log line showing that the node connected to the gateway.

If startup fails, report the exact blocker. Common blockers:

- missing `OPENCLAW_GATEWAY_TOKEN`
- unreachable `gateway.url`
- gateway handshake / auth rejection
- policy or config issues

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

Always end with a short status block:

- whether install succeeded
- whether config print succeeded
- whether `clawguard` started
- whether gateway connectivity was confirmed
- what the user should run next in OpenClaw

If it failed, say exactly what blocked completion and which command produced it.
