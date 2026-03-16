import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { AuditLogger } from "../src/audit.js";

test("audit logger recovers after a poisoned queue", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawguard-audit-"));
  const auditPath = path.join(tempDir, "audit.jsonl");
  const logger = new AuditLogger(auditPath);

  logger.queue = Promise.reject(new Error("poisoned"));
  await logger.write({ kind: "recovered", ok: true });

  const content = await fs.readFile(auditPath, "utf8");
  assert.match(content, /"kind":"recovered"/);
});
