import { ApprovalsStore } from "./approvals-store.js";
import { AuditLogger } from "./audit.js";
import { loadConfig } from "./config.js";
import { ensureDir, parseJsonText, readJsonFile } from "./fs-util.js";
import { loadOrCreateIdentity } from "./identity.js";
import { evaluatePolicy } from "./policy.js";
import { LocalApprover } from "./prompt.js";
import { ProtocolClient } from "./protocol-client.js";
import { executeRun, normalizeRunPlan, whichCommand } from "./runner.js";

function asError(error) {
  if (error instanceof Error) {
    return error;
  }
  const wrapped = new Error(String(error));
  wrapped.code = "UNKNOWN_ERROR";
  return wrapped;
}

function isConnectionReplyError(error) {
  return error?.code === "NOT_CONNECTED" || error?.code === "CONNECTION_CLOSED" || error?.code === "REQUEST_TIMEOUT";
}

async function safeAuditWrite(auditLogger, entry) {
  try {
    await auditLogger.write(entry);
    return true;
  } catch {
    return false;
  }
}

async function sendNodeInvokeResultSafely(protocolClient, payload) {
  try {
    await protocolClient.sendNodeInvokeResult(payload);
    return true;
  } catch (error) {
    if (isConnectionReplyError(error)) {
      return false;
    }
    throw error;
  }
}

async function recordDroppedReply(auditLogger, payload, error) {
  await safeAuditWrite(auditLogger, {
    kind: "reply-drop",
    replyType: payload.result !== undefined ? "result" : "error",
    requestId: payload.id,
    nodeId: payload.nodeId,
    message: error.message,
    code: error.code || null,
    details: error.details || null
  });
}

export function waitForClientDisconnectOrShutdown(protocolClient, shutdownSignal) {
  return new Promise((resolve, reject) => {
    let unsubscribeStop = () => {};

    const cleanup = () => {
      protocolClient.off("close", onClose);
      protocolClient.off("error", onError);
      unsubscribeStop();
    };

    const onClose = (event) => {
      cleanup();
      resolve({ type: "close", event });
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onStop = () => {
      cleanup();
      resolve({ type: "shutdown" });
    };

    protocolClient.once("close", onClose);
    protocolClient.once("error", onError);

    unsubscribeStop = shutdownSignal.onStop(onStop);
  });
}

export function computeReconnectDelay(baseDelayMs, attempt, random = Math.random) {
  const safeBaseDelayMs = Math.max(1, Math.floor(baseDelayMs));
  const exponent = Math.max(0, attempt - 1);
  const cappedBaseDelay = Math.min(safeBaseDelayMs * (2 ** exponent), 120_000);
  const jitterFactor = 0.75 + (Math.max(0, Math.min(1, random())) * 0.5);
  return Math.max(1, Math.round(cappedBaseDelay * jitterFactor));
}

export function createRuntimeLogger(level, output = console) {
  const normalizedLevel = ["silent", "error", "info"].includes(level) ? level : "info";

  return {
    info(message) {
      if (normalizedLevel === "info") {
        output.log(message);
      }
    },
    error(message) {
      if (normalizedLevel === "info" || normalizedLevel === "error") {
        output.error(message);
      }
    }
  };
}

function createShutdownController() {
  let stopped = false;
  const listeners = new Set();
  let resolver = null;
  const stopPromise = new Promise((resolve) => {
    resolver = resolve;
  });

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    for (const listener of listeners) {
      listener();
    }
    listeners.clear();
    resolver();
  };

  return {
    get stopped() {
      return stopped;
    },
    onStop(listener) {
      if (stopped) {
        listener();
        return () => {};
      }

      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop,
    stopPromise
  };
}

export async function createService(configPath) {
  const config = await loadConfig(configPath, { readJsonFile });

  const identity = await loadOrCreateIdentity(config.storage.statePath, config.node.id || null);
  const auditLogger = new AuditLogger(config.audit.path);
  const approvalsStore = new ApprovalsStore(config.approvals.path);
  const approver = new LocalApprover(config.approvals);

  const protocolClient = new ProtocolClient({
    gatewayUrl: config.gateway.url,
    gatewayToken: config.gateway.token,
    openTimeoutMs: config.gateway.openTimeoutMs,
    eventTimeoutMs: config.gateway.eventTimeoutMs,
    requestTimeoutMs: config.gateway.requestTimeoutMs,
    handshakeProfile: config.gateway.handshakeProfile,
    identity,
    nodeInfo: {
      displayName: config.node.displayName,
      platform: config.node.platform,
      deviceFamily: config.node.deviceFamily,
      caps: ["system"],
      commands: [
        "system.run",
        "system.which",
        "system.execApprovals.get",
        "system.execApprovals.set"
      ]
    },
    auditLogger
  });

  protocolClient.on("protocol-error", (error) => {
    void safeAuditWrite(auditLogger, {
      kind: "protocol-error",
      nodeId: identity.nodeId,
      gatewayUrl: config.gateway.url,
      message: error.message,
      code: error.code || null,
      details: error.details || null
    });
  });

  const service = {
    config,
    identity,
    auditLogger,
    approvalsStore,
    approver,
    protocolClient
  };

  protocolClient.on("request", async (frame) => {
    const { id, method } = frame;
    const params = frame.params ?? frame.payload;
    let sent;

    try {
      const result = await handleDirectRequest(service, method, params);
      sent = protocolClient.sendResponse(id, result);
      if (!sent) {
        await safeAuditWrite(auditLogger, {
          kind: "reply-drop",
          replyType: "result",
          requestId: id,
          method,
          code: "REPLY_DROPPED",
          message: "direct response dropped because gateway connection was unavailable"
        });
      }
    } catch (error) {
      const outboundError = asError(error);
      sent = protocolClient.sendError(id, outboundError);
      if (!sent) {
        await safeAuditWrite(auditLogger, {
          kind: "reply-drop",
          replyType: "error",
          requestId: id,
          method,
          code: "REPLY_DROPPED",
          message: "direct error response dropped because gateway connection was unavailable",
          details: outboundError.details || null
        });
      }
    }
  });

  protocolClient.on("event:node.invoke.request", async (params) => {
    let replyPayload;

    try {
      const result = await handleCommand(
        service,
        params.command,
        parseJsonText(params.paramsJSON || "{}", {
          context: "node.invoke.request paramsJSON",
          errorCode: "INVALID_PARAMS",
          errorMessage: "invalid node.invoke.request paramsJSON",
          details: {
            field: "paramsJSON",
            event: "node.invoke.request"
          }
        }),
        params.timeoutMs
      );
      replyPayload = {
        id: params.id,
        nodeId: identity.nodeId,
        result
      };
    } catch (error) {
      replyPayload = {
        id: params.id,
        nodeId: identity.nodeId,
        error: asError(error)
      };
    }

    try {
      const sent = await sendNodeInvokeResultSafely(protocolClient, replyPayload);
      if (!sent) {
        await recordDroppedReply(auditLogger, replyPayload, {
          message: "reply dropped because gateway connection was unavailable",
          code: "REPLY_DROPPED"
        });
      }
    } catch (error) {
      const outboundError = asError(error);
      await recordDroppedReply(auditLogger, replyPayload, outboundError);
    }
  });

  return service;
}

async function handleDirectRequest(service, method, params) {
  if (method === "node.invoke") {
    return handleNodeInvoke(service, params || {});
  }

  if (method === "system.run" || method === "system.which" || method === "system.execApprovals.get" || method === "system.execApprovals.set") {
    return handleCommand(service, method, params, null);
  }

  const error = new Error(`unsupported method: ${method}`);
  error.code = "METHOD_NOT_FOUND";
  throw error;
}

async function handleNodeInvoke(service, params) {
  const command = params.command;
  const commandParams =
    params.params ||
    params.payload ||
    (params.paramsJSON
      ? parseJsonText(params.paramsJSON, {
          context: "node.invoke paramsJSON",
          errorCode: "INVALID_PARAMS",
          errorMessage: "invalid node.invoke paramsJSON",
          details: {
            field: "paramsJSON",
            method: "node.invoke"
          }
        })
      : {});
  if (!command) {
    const error = new Error("node.invoke requires command");
    error.code = "INVALID_PARAMS";
    throw error;
  }

  return handleCommand(service, command, commandParams, params.timeoutMs || null);
}

async function handleCommand(service, method, params, invokeTimeoutMs) {
  switch (method) {
    case "system.run":
      return handleSystemRun(service, params, invokeTimeoutMs);
    case "system.which":
      return handleSystemWhich(params);
    case "system.execApprovals.get":
      return service.approvalsStore.getSnapshot();
    case "system.execApprovals.set":
      return service.approvalsStore.setSnapshot(params || {});
    default: {
      const error = new Error(`unsupported command: ${method}`);
      error.code = "METHOD_NOT_FOUND";
      throw error;
    }
  }
}

async function handleSystemWhich(params) {
  const commands = Array.isArray(params?.commands) ? params.commands : [params?.command].filter(Boolean);
  const found = {};

  for (const command of commands) {
    found[command] = await whichCommand(command);
  }

  return {
    commands: found
  };
}

async function handleSystemRun(service, params, invokeTimeoutMs) {
  const plan = await normalizeRunPlan(params || {}, service.config, invokeTimeoutMs);

  const policyDecision = evaluatePolicy(service.config, plan);
  const approvalsDecision = await service.approvalsStore.evaluate({
    agentId: plan.agentId,
    resolvedBinary: plan.resolvedBinary,
    isShellText: plan.isShellText
  });

  const decision = combineDecisions(policyDecision, approvalsDecision);
  await service.auditLogger.write({
    kind: "decision",
    agentId: plan.agentId,
    command: plan.displayCommand,
    cwd: plan.cwd,
    resolvedBinary: plan.resolvedBinary,
    policyDecision,
    approvalsDecision,
    finalAction: decision.action
  });

  if (decision.action === "deny") {
    const error = new Error(decision.reason);
    error.code = "SYSTEM_RUN_DENIED";
    error.details = { policyDecision, approvalsDecision };
    throw error;
  }

  if (decision.action === "ask") {
    const approval = await service.approver.requestApproval({
      agentId: plan.agentId,
      cwd: plan.cwd,
      displayCommand: plan.displayCommand
    });

    if (approval === "allow-always" && plan.resolvedBinary) {
      await service.approvalsStore.allowBinaryForAgent(plan.agentId, plan.resolvedBinary);
    }

    if (approval === "deny") {
      const error = new Error("operator denied execution");
      error.code = "SYSTEM_RUN_DENIED";
      error.details = { policyDecision, approvalsDecision, approval };
      throw error;
    }
  }

  const result = await executeRun(plan, service.config);
  await service.auditLogger.write({
    kind: "execution",
    agentId: plan.agentId,
    command: plan.displayCommand,
    cwd: plan.cwd,
    result
  });
  return result;
}

function combineDecisions(policyDecision, approvalsDecision) {
  const decisions = [policyDecision, approvalsDecision];

  if (decisions.some((decision) => decision.action === "deny")) {
    return {
      action: "deny",
      reason: decisions.find((decision) => decision.action === "deny").reason
    };
  }

  if (decisions.some((decision) => decision.action === "ask")) {
    return {
      action: "ask",
      reason: decisions.find((decision) => decision.action === "ask").reason
    };
  }

  return {
    action: "allow",
    reason: "allowed"
  };
}

export async function runService(configPath) {
  const service = await createService(configPath);
  const { protocolClient, config, identity } = service;
  const shutdown = createShutdownController();
  const logger = createRuntimeLogger(config.logging.level);
  const startedAt = Date.now();
  let reconnectAttempt = 0;

  const handleSignal = async (signal) => {
    await safeAuditWrite(service.auditLogger, {
      kind: "lifecycle",
      phase: "shutdown-requested",
      signal,
      nodeId: identity.nodeId,
      uptimeMs: Date.now() - startedAt
    });
    protocolClient.close();
    shutdown.stop();
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  if (!config.gateway.token && !identity.deviceToken) {
    const error = new Error(
      `missing gateway token; set ${config.gateway.tokenEnv || "OPENCLAW_GATEWAY_TOKEN"} or put a deviceToken in ${config.storage.statePath}`
    );
    error.code = "MISSING_GATEWAY_TOKEN";
    throw error;
  }

  await safeAuditWrite(service.auditLogger, {
    kind: "lifecycle",
    phase: "startup",
    nodeId: identity.nodeId,
    gatewayUrl: config.gateway.url,
    handshakeProfile: config.gateway.handshakeProfile
  });

  while (!shutdown.stopped) {
    const connectAttemptStartedAt = Date.now();
    try {
      await protocolClient.connect();
      reconnectAttempt = 0;
      logger.info(`[clawguard] connected to ${config.gateway.url} as ${identity.nodeId}`);
      await safeAuditWrite(service.auditLogger, {
        kind: "lifecycle",
        phase: "connected",
        nodeId: identity.nodeId,
        gatewayUrl: config.gateway.url,
        durationMs: Date.now() - connectAttemptStartedAt
      });

      await waitForClientDisconnectOrShutdown(protocolClient, shutdown);

      if (shutdown.stopped) {
        break;
      }
    } catch (error) {
      logger.error(`[clawguard] connection error: ${error.message}`);
      await safeAuditWrite(service.auditLogger, {
        kind: "gateway-error",
        message: error.message,
        code: error.code || null,
        nodeId: identity.nodeId,
        gatewayUrl: config.gateway.url,
        attempt: reconnectAttempt + 1,
        durationMs: Date.now() - connectAttemptStartedAt
      });
    }

    if (shutdown.stopped) {
      break;
    }

    reconnectAttempt += 1;
    const reconnectDelayMs = computeReconnectDelay(config.gateway.reconnectMs, reconnectAttempt);
    logger.info(`[clawguard] reconnecting in ${reconnectDelayMs}ms`);
    await safeAuditWrite(service.auditLogger, {
      kind: "lifecycle",
      phase: "reconnect-scheduled",
      nodeId: identity.nodeId,
      gatewayUrl: config.gateway.url,
      attempt: reconnectAttempt,
      delayMs: reconnectDelayMs
    });

    await Promise.race([
      shutdown.stopPromise,
      new Promise((resolve) => {
        setTimeout(resolve, reconnectDelayMs);
      })
    ]);
  }

  await safeAuditWrite(service.auditLogger, {
    kind: "lifecycle",
    phase: "shutdown-complete",
    nodeId: identity.nodeId,
    uptimeMs: Date.now() - startedAt
  });

  process.removeListener("SIGINT", handleSignal);
  process.removeListener("SIGTERM", handleSignal);
}
