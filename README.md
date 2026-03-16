# clawguard

`clawguard` is a small OpenClaw-compatible node host that puts a local policy, approval, and audit layer in front of execution.

## One Prompt

```text
Read https://raw.githubusercontent.com/rleungx/clawguard/main/SKILL.md and install, configure, and start clawguard for OpenClaw.
```

## Architecture

- OpenClaw decides what it wants to do.
- `clawguard` is the local execution boundary between OpenClaw and the real machine.
- Every execution request passes through local policy, approvals, and audit before it reaches the operating system.
- The machine only executes what the local boundary explicitly allows.

## What It Exposes

- `system.run`
- `system.which`
- `system.execApprovals.get`
- `system.execApprovals.set`

## Defaults

- Gateway auth comes from `OPENCLAW_GATEWAY_TOKEN`.
- The packaged example config is a safe starting point, not a machine-specific workflow preset.
- Local policy defaults to deny and requires explicit allow rules or approvals.
