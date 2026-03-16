import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { ApprovalsStore } from "../src/approvals-store.js";

test("approvals ask on allowlist miss by default", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawguard-"));
  const store = new ApprovalsStore(path.join(tempDir, "exec-approvals.json"));

  const decision = await store.evaluate({
    agentId: "demo-agent",
    resolvedBinary: "/usr/bin/git",
    isShellText: false
  });

  assert.equal(decision.action, "ask");
});

test("approvals can remember a binary for an agent", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawguard-"));
  const store = new ApprovalsStore(path.join(tempDir, "exec-approvals.json"));

  await store.allowBinaryForAgent("demo-agent", "/usr/bin/git");

  const decision = await store.evaluate({
    agentId: "demo-agent",
    resolvedBinary: "/usr/bin/git",
    isShellText: false
  });

  assert.equal(decision.action, "allow");
});

test("approvals fail closed on malformed on-disk JSON", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawguard-"));
  const approvalsPath = path.join(tempDir, "exec-approvals.json");
  const store = new ApprovalsStore(approvalsPath);
  await fs.writeFile(approvalsPath, "{not valid json", "utf8");

  await assert.rejects(
    store.evaluate({
      agentId: "demo-agent",
      resolvedBinary: "/usr/bin/git",
      isShellText: false
    }),
    (error) => error.code === "INVALID_APPROVALS_JSON" && error.details?.filePath === approvalsPath
  );
});

test("approvals reject malformed snapshot JSON", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawguard-"));
  const approvalsPath = path.join(tempDir, "exec-approvals.json");
  const store = new ApprovalsStore(approvalsPath);

  await assert.rejects(
    store.setSnapshot({ file: "{not valid json" }),
    (error) => error.code === "INVALID_APPROVALS_JSON" && error.details?.filePath === approvalsPath
  );
});
