import path from "node:path";

import { matchesAny } from "./glob.js";
import { normalizeMatchPath } from "./fs-util.js";

function looksLikeUrl(value) {
  return /^(https?|wss?):\/\//.test(value);
}

function resolveCandidatePath(argument, cwd) {
  if (!argument || looksLikeUrl(argument) || argument.startsWith("-")) {
    return null;
  }

  if (argument.startsWith("~")) {
    return normalizeMatchPath(argument.replace(/^~(?=\/)/, process.env.HOME || "~"));
  }

  if (path.isAbsolute(argument)) {
    return normalizeMatchPath(argument);
  }

  if (argument.startsWith("./") || argument.startsWith("../")) {
    return normalizeMatchPath(path.resolve(cwd, argument));
  }

  return null;
}

function ruleMatches(rule, context) {
  const binaryPatterns = rule.match?.binary || [];
  const argvIncludes = rule.match?.argvIncludes || [];
  const requiresShell = rule.match?.shell;
  const normalizedCwd = normalizeMatchPath(context.cwd);

  if (binaryPatterns.length > 0) {
    const candidates = [context.resolvedBinary, context.binaryName].filter(Boolean);
    const matchedBinary = candidates.some((candidate) => matchesAny(binaryPatterns, candidate));
    if (!matchedBinary) {
      return false;
    }
  }

  if (argvIncludes.length > 0) {
    const argvText = context.argv.join(" ");
    const includesAll = argvIncludes.every((needle) => argvText.includes(needle));
    if (!includesAll) {
      return false;
    }
  }

  if (typeof requiresShell === "boolean" && requiresShell !== context.isShellText) {
    return false;
  }

  if (rule.cwd?.length > 0 && !matchesAny(rule.cwd, normalizedCwd)) {
    return false;
  }

  return true;
}

export function evaluatePolicy(config, context) {
  const normalizedCwd = normalizeMatchPath(context.cwd);

  if (context.isShellText && !config.policy.allowShellText) {
    return {
      source: "policy",
      action: "deny",
      reason: "shell text is disabled"
    };
  }

  if (matchesAny(config.policy.denyPaths, normalizedCwd)) {
    return {
      source: "policy",
      action: "deny",
      reason: "cwd matches denied path"
    };
  }

  const touchedPaths = context.argv.map((argument) => resolveCandidatePath(argument, context.cwd)).filter(Boolean);
  const deniedPath = touchedPaths.find((candidate) => matchesAny(config.policy.denyPaths, candidate));
  if (deniedPath) {
    return {
      source: "policy",
      action: "deny",
      reason: `argument path denied: ${deniedPath}`
    };
  }

  const matchingRule = config.policy.commandRules.find((rule) => ruleMatches(rule, context));
  if (matchingRule) {
    return {
      source: "policy",
      action: matchingRule.action,
      reason: matchingRule.id ? `matched rule ${matchingRule.id}` : "matched command rule"
    };
  }

  return {
    source: "policy",
    action: config.policy.defaultAction,
    reason: "default action"
  };
}
