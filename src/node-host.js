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

export async function createService(configPath) {
  const config = await loadConfig(configPath, { readJsonFile });
  await ensureDir(config.storage.dir);

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
      browserToolsEnabled: config.node.browserToolsEnabled,
      browserProxyEnabled: config.node.browserProxyEnabled,
      caps: ["system"],
      commands: [
        "system.run",
        "system.which",
        "system.execApprovals.get",
        "system.execApprovals.set"
      ],
      permissions: {}
    },
    auditLogger
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

    try {
      const result = await handleDirectRequest(service, method, params);
      protocolClient.sendResponse(id, result);
    } catch (error) {
      protocolClient.sendError(id, asError(error));
    }
  });

  protocolClient.on("event:node.invoke.request", async (params) => {
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
      await protocolClient.sendNodeInvokeResult({
        id: params.id,
        nodeId: identity.nodeId,
        result
      });
    } catch (error) {
      await protocolClient.sendNodeInvokeResult({
        id: params.id,
        nodeId: identity.nodeId,
        error: asError(error)
      });
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

  if (!config.gateway.token && !identity.deviceToken) {
    const error = new Error(
      `missing gateway token; set ${config.gateway.tokenEnv || "OPENCLAW_GATEWAY_TOKEN"} or put a deviceToken in ${config.storage.statePath}`
    );
    error.code = "MISSING_GATEWAY_TOKEN";
    throw error;
  }

  while (true) {
    try {
      await protocolClient.connect();
      console.log(`[secure-node] connected to ${config.gateway.url} as ${identity.nodeId}`);
      await new Promise((resolve, reject) => {
        protocolClient.once("close", resolve);
        protocolClient.once("error", reject);
      });
    } catch (error) {
      console.error(`[secure-node] connection error: ${error.message}`);
      await service.auditLogger.write({
        kind: "gateway-error",
        message: error.message,
        code: error.code || null
      });
    }

    console.log(`[secure-node] reconnecting in ${config.gateway.reconnectMs}ms`);
    await new Promise((resolve) => {
      setTimeout(resolve, config.gateway.reconnectMs);
    });
  }
}
