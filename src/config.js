import os from "node:os";
import path from "node:path";
import { expandHome } from "./fs-util.js";

const DEFAULT_CONFIG = {
  gateway: {
    url: "ws://127.0.0.1:18789",
    reconnectMs: 3000,
    openTimeoutMs: 10000,
    eventTimeoutMs: 10000,
    requestTimeoutMs: 15000,
    handshakeProfile: "auto",
    tokenEnv: "OPENCLAW_GATEWAY_TOKEN",
    token: null
  },
  node: {
    displayName: `clawguard@${os.hostname()}`,
    platform: process.platform,
    deviceFamily: "headless",
    browserToolsEnabled: false,
    browserProxyEnabled: false
  },
  storage: {
    dir: ".clawguard"
  },
  approvals: {
    path: ".clawguard/exec-approvals.json",
    askMode: "tty",
    askFallback: "deny",
    askTimeoutMs: 300000
  },
  policy: {
    defaultAction: "deny",
    allowShellText: false,
    envAllowlist: ["TERM", "LANG", "LC_*", "COLORTERM", "NO_COLOR", "FORCE_COLOR"],
    denyEnvPrefixes: [
      "PATH",
      "LD_",
      "DYLD_",
      "NODE_OPTIONS",
      "PYTHON",
      "PERL",
      "RUBYOPT",
      "SHELLOPTS",
      "PS4"
    ],
    denyPaths: ["~/.ssh/**", "~/.aws/**", "~/.openclaw/**"],
    commandRules: []
  },
  runner: {
    maxOutputBytes: 1024 * 1024,
    defaultCwd: process.cwd(),
    shell: process.env.SHELL || "/bin/zsh"
  },
  audit: {
    path: ".clawguard/audit.jsonl"
  },
  logging: {
    level: "info"
  }
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(baseValue, overrideValue) {
  if (Array.isArray(baseValue) || Array.isArray(overrideValue)) {
    return overrideValue ?? baseValue;
  }
  if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
    const merged = { ...baseValue };
    for (const [key, value] of Object.entries(overrideValue)) {
      merged[key] = deepMerge(baseValue[key], value);
    }
    return merged;
  }
  return overrideValue ?? baseValue;
}

function expandConfigPath(value, baseDir) {
  const expanded = expandHome(value);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

function expandMatchBinaryPatterns(values = [], baseDir) {
  return values.map((value) => {
    const expanded = expandHome(value);
    if (expanded.startsWith(".") || expanded.startsWith("~") || expanded.includes(path.sep)) {
      return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
    }
    return value;
  });
}

function configError(message, details) {
  const error = new Error(message);
  error.code = "INVALID_CONFIG";
  error.details = details;
  return error;
}

function validatePositiveInteger(value, key, { min = 1, max = 2_147_483_647 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw configError(`invalid ${key}`, { key, value, min, max });
  }
}

function validateGatewayUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw configError("invalid gateway.url", { key: "gateway.url", value });
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw configError("invalid gateway.url", { key: "gateway.url", value });
  }

  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw configError("invalid gateway.url", { key: "gateway.url", value, allowedProtocols: ["ws:", "wss:"] });
  }
}

function validateConfig(config) {
  validateGatewayUrl(config.gateway.url);
  validatePositiveInteger(config.gateway.reconnectMs, "gateway.reconnectMs");
  validatePositiveInteger(config.gateway.openTimeoutMs, "gateway.openTimeoutMs");
  validatePositiveInteger(config.gateway.eventTimeoutMs, "gateway.eventTimeoutMs");
  validatePositiveInteger(config.gateway.requestTimeoutMs, "gateway.requestTimeoutMs");
  validatePositiveInteger(config.approvals.askTimeoutMs, "approvals.askTimeoutMs");
  validatePositiveInteger(config.runner.maxOutputBytes, "runner.maxOutputBytes");

  if (!config.gateway.token && (typeof config.gateway.tokenEnv !== "string" || config.gateway.tokenEnv.trim().length === 0)) {
    throw configError("invalid gateway.tokenEnv", { key: "gateway.tokenEnv", value: config.gateway.tokenEnv });
  }

  if (!path.isAbsolute(config.runner.defaultCwd)) {
    throw configError("invalid runner.defaultCwd", { key: "runner.defaultCwd", value: config.runner.defaultCwd });
  }

  if (typeof config.gateway.handshakeProfile !== "string" || !["auto", "modern", "legacy"].includes(config.gateway.handshakeProfile)) {
    throw configError("invalid gateway.handshakeProfile", {
      key: "gateway.handshakeProfile",
      value: config.gateway.handshakeProfile,
      allowed: ["auto", "modern", "legacy"]
    });
  }

  if (typeof config.logging.level !== "string" || !["silent", "error", "info"].includes(config.logging.level)) {
    throw configError("invalid logging.level", {
      key: "logging.level",
      value: config.logging.level,
      allowed: ["silent", "error", "info"]
    });
  }
}

export async function loadConfig(filePath, { readJsonFile }) {
  const resolvedConfigPath = filePath ? path.resolve(filePath) : null;
  const baseDir = resolvedConfigPath ? path.dirname(resolvedConfigPath) : process.cwd();
  const userConfig = filePath
    ? await readJsonFile(filePath, {}, { errorCode: "INVALID_CONFIG_JSON", errorMessage: "invalid config JSON" })
    : {};

  const merged = deepMerge(DEFAULT_CONFIG, userConfig ?? {});
  const storageDir = expandConfigPath(merged.storage.dir, baseDir);
  const gatewayToken =
    process.env[merged.gateway.tokenEnv] || merged.gateway.token || process.env.OPENCLAW_GATEWAY_TOKEN || null;

  const resolvedConfig = {
    ...merged,
    gateway: {
      ...merged.gateway,
      token: gatewayToken
    },
    storage: {
      ...merged.storage,
      dir: storageDir,
      statePath: path.join(storageDir, "state.json")
    },
    approvals: {
      ...merged.approvals,
      path: expandConfigPath(merged.approvals.path, baseDir)
    },
    audit: {
      ...merged.audit,
      path: expandConfigPath(merged.audit.path, baseDir)
    },
    runner: {
      ...merged.runner,
      defaultCwd: expandConfigPath(merged.runner.defaultCwd, baseDir),
      shell: expandHome(merged.runner.shell)
    },
    policy: {
      ...merged.policy,
      denyPaths: (merged.policy.denyPaths || []).map((value) => expandConfigPath(value, baseDir)),
      commandRules: (merged.policy.commandRules || []).map((rule) => ({
        ...rule,
        match: {
          ...(rule.match || {}),
          binary: expandMatchBinaryPatterns(rule.match?.binary || [], baseDir)
        },
        cwd: (rule.cwd || []).map((value) => expandConfigPath(value, baseDir))
      }))
    }
  };

  validateConfig(resolvedConfig);
  return resolvedConfig;
}
