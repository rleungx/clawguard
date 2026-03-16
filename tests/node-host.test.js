import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { computeReconnectDelay, createRuntimeLogger, createService, waitForClientDisconnectOrShutdown } from "../src/node-host.js";

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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawguard-host-"));
  const configPath = path.join(tempDir, "clawguard.config.json");

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

test("node host reconnect delay grows with jittered backoff", () => {
  const firstAttempt = computeReconnectDelay(1000, 1, () => 0);
  const secondAttempt = computeReconnectDelay(1000, 2, () => 0);
  const thirdAttempt = computeReconnectDelay(1000, 3, () => 1);

  assert.equal(firstAttempt, 750);
  assert.equal(secondAttempt, 1500);
  assert.equal(thirdAttempt, 5000);
});

test("node host runtime logger respects log levels", () => {
  const messages = [];
  const output = {
    log(message) {
      messages.push(["info", message]);
    },
    error(message) {
      messages.push(["error", message]);
    }
  };

  const infoLogger = createRuntimeLogger("info", output);
  infoLogger.info("connected");
  infoLogger.error("failed");

  const errorLogger = createRuntimeLogger("error", output);
  errorLogger.info("ignored");
  errorLogger.error("retrying");

  const silentLogger = createRuntimeLogger("silent", output);
  silentLogger.info("ignored");
  silentLogger.error("ignored");

  assert.deepEqual(messages, [
    ["info", "connected"],
    ["error", "failed"],
    ["error", "retrying"]
  ]);
});

test("node host swallows protocol-error audit write failures", async () => {
  const service = await createTestService();
  const originalWrite = service.auditLogger.write;
  let unhandledError = null;

  service.auditLogger.write = async () => {
    throw new Error("disk full");
  };

  const onUnhandledRejection = (error) => {
    unhandledError = error;
  };
  process.once("unhandledRejection", onUnhandledRejection);

  service.protocolClient.emit("protocol-error", new Error("bad frame"));
  await new Promise((resolve) => setTimeout(resolve, 20));

  process.removeListener("unhandledRejection", onUnhandledRejection);
  service.auditLogger.write = originalWrite;
  assert.equal(unhandledError, null);
});

test("node host ignores invoke result reply failures after disconnect", async () => {
  const service = await createTestService();
  let unhandledError = null;

  service.protocolClient.sendNodeInvokeResult = async () => {
    const error = new Error("socket closed");
    error.code = "NOT_CONNECTED";
    throw error;
  };

  const onUnhandledRejection = (error) => {
    unhandledError = error;
  };
  process.once("unhandledRejection", onUnhandledRejection);

  service.protocolClient.emit("event:node.invoke.request", {
    id: "req-5",
    command: "system.which",
    paramsJSON: JSON.stringify({ commands: ["node"] })
  });

  await new Promise((resolve) => setTimeout(resolve, 20));

  process.removeListener("unhandledRejection", onUnhandledRejection);
  assert.equal(unhandledError, null);
});

test("node host records dropped replies for disconnected reply paths", async () => {
  for (const code of ["NOT_CONNECTED", "CONNECTION_CLOSED"]) {
    const service = await createTestService();
    const recordedEntries = [];
    const originalWrite = service.auditLogger.write;

    service.auditLogger.write = async (entry) => {
      recordedEntries.push(entry);
      return originalWrite.call(service.auditLogger, entry);
    };
    service.protocolClient.sendNodeInvokeResult = async () => {
      const error = new Error(code.toLowerCase());
      error.code = code;
      throw error;
    };

    service.protocolClient.emit("event:node.invoke.request", {
      id: `req-${code}`,
      command: "system.which",
      paramsJSON: JSON.stringify({ commands: ["node"] })
    });

    await waitFor(() => recordedEntries.some((entry) => entry.kind === "reply-drop"));

    const replyDrop = recordedEntries.find((entry) => entry.kind === "reply-drop");
    assert.equal(replyDrop?.requestId, `req-${code}`);
    assert.equal(replyDrop?.code, "REPLY_DROPPED");
  }
});

test("node host disconnect waiter cleans up listeners on close and shutdown", async () => {
  const protocolClient = new EventEmitter();
  let resolveStop;
  const stopListeners = new Set();
  const stopController = {
    stopPromise: new Promise((resolve) => {
      resolveStop = resolve;
    }),
    onStop(listener) {
      stopListeners.add(listener);
      return () => {
        stopListeners.delete(listener);
      };
    },
    stop() {
      for (const listener of stopListeners) {
        listener();
      }
      stopListeners.clear();
      resolveStop();
    }
  };

  const closePromise = waitForClientDisconnectOrShutdown(protocolClient, stopController);
  assert.equal(protocolClient.listenerCount("close"), 1);
  assert.equal(protocolClient.listenerCount("error"), 1);
  protocolClient.emit("close", { code: 1000 });
  const closeResult = await closePromise;
  assert.equal(closeResult.type, "close");
  assert.equal(protocolClient.listenerCount("close"), 0);
  assert.equal(protocolClient.listenerCount("error"), 0);

  const shutdownPromise = waitForClientDisconnectOrShutdown(protocolClient, stopController);
  assert.equal(protocolClient.listenerCount("close"), 1);
  assert.equal(protocolClient.listenerCount("error"), 1);
  stopController.stop();
  const shutdownResult = await shutdownPromise;
  assert.equal(shutdownResult.type, "shutdown");
  assert.equal(protocolClient.listenerCount("close"), 0);
  assert.equal(protocolClient.listenerCount("error"), 0);
  assert.equal(stopListeners.size, 0);
});

test("node host disconnect waiter cleans up listeners on error", async () => {
  const protocolClient = new EventEmitter();
  let resolveStop;
  const stopListeners = new Set();
  const stopController = {
    stopPromise: new Promise((resolve) => {
      resolveStop = resolve;
    }),
    onStop(listener) {
      stopListeners.add(listener);
      return () => {
        stopListeners.delete(listener);
      };
    },
    stop() {
      for (const listener of stopListeners) {
        listener();
      }
      stopListeners.clear();
      resolveStop();
    }
  };

  const waitPromise = waitForClientDisconnectOrShutdown(protocolClient, stopController);
  const boom = new Error("boom");
  protocolClient.emit("error", boom);

  await assert.rejects(waitPromise, (error) => error === boom);
  assert.equal(protocolClient.listenerCount("close"), 0);
  assert.equal(protocolClient.listenerCount("error"), 0);
  assert.equal(stopListeners.size, 0);
});

test("node host records dropped replies on invoke result timeout", async () => {
  const service = await createTestService();
  const recordedEntries = [];
  const originalWrite = service.auditLogger.write;

  service.auditLogger.write = async (entry) => {
    recordedEntries.push(entry);
    return originalWrite.call(service.auditLogger, entry);
  };
  service.protocolClient.sendNodeInvokeResult = async () => {
    const error = new Error("timed out");
    error.code = "REQUEST_TIMEOUT";
    throw error;
  };

  service.protocolClient.emit("event:node.invoke.request", {
    id: "req-6",
    command: "system.which",
    paramsJSON: JSON.stringify({ commands: ["node"] })
  });

  await waitFor(() => recordedEntries.some((entry) => entry.kind === "reply-drop"));

  const replyDrop = recordedEntries.find((entry) => entry.kind === "reply-drop");
  assert.equal(replyDrop?.requestId, "req-6");
  assert.equal(replyDrop?.code, "REPLY_DROPPED");
});

test("node host signal handling closes the live protocol client", async () => {
  const service = await createTestService();
  let closeCalls = 0;

  service.protocolClient.close = () => {
    closeCalls += 1;
    return true;
  };

  const handleSignal = async (signal) => {
    await service.auditLogger.write({
      kind: "lifecycle",
      phase: "shutdown-requested",
      signal,
      nodeId: service.identity.nodeId,
      uptimeMs: 0
    });
    service.protocolClient.close();
  };

  await handleSignal("SIGTERM");
  assert.equal(closeCalls, 1);
});

test("node host audits dropped direct request responses on closed connections", async () => {
  const service = await createTestService();
  const recordedEntries = [];
  const originalWrite = service.auditLogger.write;

  service.auditLogger.write = async (entry) => {
    recordedEntries.push(entry);
    return originalWrite.call(service.auditLogger, entry);
  };
  service.protocolClient.sendResponse = () => false;

  service.protocolClient.emit("request", {
    id: "req-direct-1",
    method: "system.which",
    params: { commands: ["node"] }
  });

  await waitFor(() => recordedEntries.some((entry) => entry.kind === "reply-drop"));

  const replyDrop = recordedEntries.find((entry) => entry.kind === "reply-drop");
  assert.equal(replyDrop?.requestId, "req-direct-1");
  assert.equal(replyDrop?.replyType, "result");
  assert.equal(replyDrop?.code, "REPLY_DROPPED");
});
