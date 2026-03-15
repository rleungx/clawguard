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
    tokenEnv: "OPENCLAW_GATEWAY_TOKEN",
    token: null
  },
  node: {
    displayName: `secure-node@${os.hostname()}`,
    platform: process.platform,
    deviceFamily: "headless",
    browserToolsEnabled: false,
    browserProxyEnabled: false
  },
  storage: {
    dir: ".secure-node"
  },
  approvals: {
    path: ".secure-node/exec-approvals.json",
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
    path: ".secure-node/audit.jsonl"
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
    return expanded;
  });
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

  return {
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
}
