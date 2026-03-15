import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { createService } from "../src/node-host.js";

async function waitFor(check, timeoutMs = 250) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  return check();
}

async function createTestService() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "secure-node-host-"));
  const configPath = path.join(tempDir, "secure-node.config.json");

  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        storage: { dir: path.join(tempDir, ".state") },
        approvals: { path: path.join(tempDir, ".state", "exec-approvals.json") },
        audit: { path: path.join(tempDir, ".state", "audit.jsonl") }
      },
      null,
      2
    ),
    "utf8"
  );

  return createService(configPath);
}

test("node host returns INVALID_PARAMS for malformed direct node.invoke paramsJSON", async () => {
  const service = await createTestService();
  let sentError;

  service.protocolClient.sendError = (id, error) => {
    sentError = { id, error };
  };

  service.protocolClient.emit("request", {
    id: "req-1",
    method: "node.invoke",
    params: {
      command: "system.which",
      paramsJSON: "{not valid json"
    }
  });

  await waitFor(() => sentError);

  assert.equal(sentError?.id, "req-1");
  assert.equal(sentError?.error?.code, "INVALID_PARAMS");
  assert.equal(sentError?.error?.details?.method, "node.invoke");
  assert.equal(sentError?.error?.details?.field, "paramsJSON");
});

test("node host returns INVALID_PARAMS for malformed node.invoke.request paramsJSON", async () => {
  const service = await createTestService();
  let invokeResult;

  service.protocolClient.sendNodeInvokeResult = async (payload) => {
    invokeResult = payload;
  };

  service.protocolClient.emit("event:node.invoke.request", {
    id: "req-2",
    command: "system.which",
    paramsJSON: "{not valid json"
  });

  await waitFor(() => invokeResult);

  assert.equal(invokeResult?.id, "req-2");
  assert.equal(invokeResult?.error?.code, "INVALID_PARAMS");
  assert.equal(invokeResult?.error?.details?.event, "node.invoke.request");
  assert.equal(invokeResult?.error?.details?.field, "paramsJSON");
});

test("node host returns system.which results through node.invoke.request", async () => {
  const service = await createTestService();
  let invokeResult;

  service.protocolClient.sendNodeInvokeResult = async (payload) => {
    invokeResult = payload;
  };

  service.protocolClient.emit("event:node.invoke.request", {
    id: "req-3",
    command: "system.which",
    paramsJSON: JSON.stringify({ commands: ["node"] })
  });

  await waitFor(() => invokeResult);

  assert.equal(invokeResult?.id, "req-3");
  assert.equal(typeof invokeResult?.result?.commands?.node, "string");
});

test("node host returns denied system.run errors through node.invoke.request", async () => {
  const service = await createTestService();
  let invokeResult;

  service.protocolClient.sendNodeInvokeResult = async (payload) => {
    invokeResult = payload;
  };

  service.protocolClient.emit("event:node.invoke.request", {
    id: "req-4",
    command: "system.run",
    paramsJSON: JSON.stringify({
      command: [process.execPath, "-e", "console.log('nope')"],
      cwd: process.cwd()
    })
  });

  await waitFor(() => invokeResult);

  assert.equal(invokeResult?.id, "req-4");
  assert.equal(invokeResult?.error?.code, "SYSTEM_RUN_DENIED");
});
