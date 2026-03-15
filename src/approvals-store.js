import crypto from "node:crypto";
import path from "node:path";

import { matchesAny } from "./glob.js";
import {
  normalizeMatchPath,
  parseJsonText,
  pathExists,
  readJsonFile,
  sha256Hex,
  stableJson,
  writeJsonFileAtomic
} from "./fs-util.js";

const DEFAULT_APPROVALS = {
  version: 1,
  socket: null,
  defaults: {
    security: "deny",
    ask: "on-miss",
    askFallback: "deny",
    autoAllowSkills: false
  },
  agents: {
    "*": {
      security: "allowlist",
      ask: "on-miss",
      askFallback: "deny",
      autoAllowSkills: false,
      allowlist: []
    }
  }
};

function normalizeAllowlistEntry(entry) {
  if (typeof entry === "string") {
    return {
      id: crypto.randomUUID(),
      pattern: entry
    };
  }

  return {
    id: entry.id || crypto.randomUUID(),
    pattern: entry.pattern,
    lastUsedAt: entry.lastUsedAt,
    lastUsedCommand: entry.lastUsedCommand,
    lastResolvedPath: entry.lastResolvedPath
  };
}

function effectiveAgentConfig(document, agentId) {
  const defaults = document.defaults || DEFAULT_APPROVALS.defaults;
  const wildcard = document.agents?.["*"] || {};
  const specific = agentId ? document.agents?.[agentId] || {} : {};

  return {
    security: specific.security || wildcard.security || defaults.security || "allowlist",
    ask: specific.ask || wildcard.ask || defaults.ask || "on-miss",
    askFallback: specific.askFallback || wildcard.askFallback || defaults.askFallback || "deny",
    autoAllowSkills:
      specific.autoAllowSkills ?? wildcard.autoAllowSkills ?? defaults.autoAllowSkills ?? false,
    allowlist: [...(wildcard.allowlist || []), ...(specific.allowlist || [])]
  };
}

function normalizeApprovalsDocument(document) {
  return {
    version: document.version || 1,
    socket: document.socket
      ? {
          path: document.socket.path,
          token: document.socket.token
        }
      : null,
    defaults: {
      security: document.defaults?.security || "deny",
      ask: document.defaults?.ask || "on-miss",
      askFallback: document.defaults?.askFallback || "deny",
      autoAllowSkills: document.defaults?.autoAllowSkills ?? false
    },
    agents: Object.fromEntries(
      Object.entries(document.agents || DEFAULT_APPROVALS.agents).map(([agentId, config]) => {
        const rawAllowlist = config.allowlist || config.allow || [];
        const allowlist = [...new Map(rawAllowlist.map((entry) => {
          const normalized = normalizeAllowlistEntry(entry);
          return [normalized.pattern, normalized];
        })).values()];

        return [
          agentId,
          {
            security: config.security || "allowlist",
            ask: config.ask || "on-miss",
            askFallback: config.askFallback || "deny",
            autoAllowSkills: config.autoAllowSkills ?? false,
            allowlist
          }
        ];
      })
    )
  };
}

function buildSeedAgentConfig(document, agentId) {
  const seed = effectiveAgentConfig(document, agentId);
  return {
    security: seed.security === "deny" ? "allowlist" : seed.security,
    ask: seed.ask,
    askFallback: seed.askFallback,
    autoAllowSkills: seed.autoAllowSkills,
    allowlist: []
  };
}

export class ApprovalsStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async load() {
    return normalizeApprovalsDocument(
      (await readJsonFile(this.filePath, DEFAULT_APPROVALS, {
        errorCode: "INVALID_APPROVALS_JSON",
        errorMessage: "invalid approvals JSON"
      })) || DEFAULT_APPROVALS
    );
  }

  async getSnapshot() {
    const exists = await pathExists(this.filePath);
    const document = await this.load();
    const file = `${JSON.stringify(document, null, 2)}\n`;

    return {
      path: this.filePath,
      exists,
      hash: sha256Hex(JSON.stringify(stableJson(document))),
      file
    };
  }

  async setSnapshot({ file, hash }) {
    const current = await this.getSnapshot();
    if (hash && current.hash !== hash) {
      const error = new Error("approval file changed on disk");
      error.code = "APPROVALS_CONFLICT";
      error.details = { expectedHash: hash, actualHash: current.hash };
      throw error;
    }

    const parsed = parseJsonText(file, {
      filePath: this.filePath,
      errorCode: "INVALID_APPROVALS_JSON",
      errorMessage: "invalid approvals JSON"
    });
    const document = normalizeApprovalsDocument(parsed);
    await writeJsonFileAtomic(this.filePath, document);
    return this.getSnapshot();
  }

  async evaluate({ agentId, resolvedBinary, isShellText }) {
    const document = await this.load();
    const effective = effectiveAgentConfig(document, agentId);
    const normalizedBinary = resolvedBinary ? normalizeMatchPath(resolvedBinary) : null;

    if (effective.security === "deny") {
      return {
        source: "approvals",
        action: "deny",
        reason: "security=deny"
      };
    }

    const allowPatterns = effective.allowlist.map((entry) => entry.pattern).filter(Boolean);
    const matchedAllow = normalizedBinary ? matchesAny(allowPatterns, normalizedBinary) : false;

    if (effective.security === "allowlist" && !matchedAllow) {
      if (effective.ask === "always" || effective.ask === "on-miss") {
        return {
          source: "approvals",
          action: "ask",
          reason: isShellText ? "shell text not on allowlist" : "binary not on allowlist",
          askFallback: effective.askFallback
        };
      }

      return {
        source: "approvals",
        action: "deny",
        reason: "binary not on allowlist"
      };
    }

    if (effective.ask === "always") {
      return {
        source: "approvals",
        action: "ask",
        reason: "ask=always",
        askFallback: effective.askFallback
      };
    }

    return {
      source: "approvals",
      action: "allow",
      reason: matchedAllow ? "binary matched allowlist" : "security=full"
    };
  }

  async allowBinaryForAgent(agentId, binaryPath) {
    const document = await this.load();
    const targetAgentId = agentId || "*";
    if (!document.agents[targetAgentId]) {
      document.agents[targetAgentId] = buildSeedAgentConfig(document, targetAgentId);
    }

    const normalizedBinary = normalizeMatchPath(path.resolve(binaryPath));
    const hasEntry = document.agents[targetAgentId].allowlist.some((entry) => entry.pattern === normalizedBinary);
    if (!hasEntry) {
      document.agents[targetAgentId].allowlist.push({
        id: crypto.randomUUID(),
        pattern: normalizedBinary,
        lastUsedAt: Date.now(),
        lastResolvedPath: normalizedBinary
      });
    }

    await writeJsonFileAtomic(this.filePath, normalizeApprovalsDocument(document));
  }
}
