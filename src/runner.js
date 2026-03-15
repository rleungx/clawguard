import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { normalizeMatchPath, pathExists } from "./fs-util.js";

function pathKey(name) {
  return process.platform === "win32" ? name.toLowerCase() : name;
}

function envEntriesToObject(rawEnv) {
  if (!rawEnv) {
    return {};
  }

  if (Array.isArray(rawEnv)) {
    return Object.fromEntries(
      rawEnv
        .filter((entry) => typeof entry === "string" && entry.includes("="))
        .map((entry) => {
          const index = entry.indexOf("=");
          return [entry.slice(0, index), entry.slice(index + 1)];
        })
    );
  }

  if (typeof rawEnv === "object") {
    return { ...rawEnv };
  }

  return {};
}

function envNameAllowed(name, config) {
  const allowlist = config.policy.envAllowlist || [];
  return allowlist.some((pattern) => {
    if (pattern.endsWith("*")) {
      return name.startsWith(pattern.slice(0, -1));
    }
    return name === pattern;
  });
}

function envNameDenied(name, config) {
  return (config.policy.denyEnvPrefixes || []).some((prefix) => name.startsWith(prefix));
}

export async function whichCommand(command, envPath = process.env.PATH, cwd = process.cwd()) {
  if (!command) {
    return null;
  }

  if (command.includes(path.sep)) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return (await pathExists(absolute)) ? absolute : null;
  }

  for (const entry of (envPath || "").split(path.delimiter)) {
    if (!entry) {
      continue;
    }
    const candidate = path.join(entry, command);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

function truncateText(text, maxBytes) {
  if (!text) {
    return "";
  }

  const size = Buffer.byteLength(text);
  if (size <= maxBytes) {
    return text;
  }

  const truncated = Buffer.from(text).subarray(0, maxBytes).toString("utf8");
  return `${truncated}\n[secure-node] output truncated to ${maxBytes} bytes`;
}

function appendTruncationNotice(text, maxBytes) {
  return `${text}\n[secure-node] output truncated to ${maxBytes} bytes`;
}

function createOutputCollector(maxBytes) {
  const chunks = [];
  let bufferedBytes = 0;
  let truncated = false;

  return {
    push(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remainingBytes = Math.max(0, maxBytes - bufferedBytes);

      if (remainingBytes > 0) {
        const slice = buffer.subarray(0, remainingBytes);
        if (slice.length > 0) {
          chunks.push(slice);
          bufferedBytes += slice.length;
        }
      }

      if (buffer.length > remainingBytes) {
        truncated = true;
      }
    },
    toString() {
      const output = Buffer.concat(chunks).toString("utf8");
      return truncated ? appendTruncationNotice(output, maxBytes) : output;
    }
  };
}

export async function normalizeRunPlan(rawParams, config, invokeTimeoutMs = null) {
  const cwd = path.resolve(rawParams.cwd || rawParams.workdir || config.runner.defaultCwd);
  const commandValue = rawParams.command ?? rawParams.argv ?? rawParams.cmd;
  const timeoutMs = Math.min(
    rawParams.commandTimeoutMs || rawParams.timeoutMs || invokeTimeoutMs || 120000,
    invokeTimeoutMs || Number.MAX_SAFE_INTEGER
  );
  const envOverrides = envEntriesToObject(rawParams.env);

  let argv;
  let isShellText = false;

  if (Array.isArray(commandValue)) {
    argv = [...commandValue];
  } else if (typeof commandValue === "string") {
    isShellText = true;
    argv = [config.runner.shell, "-lc", commandValue];
  } else {
    const error = new Error("system.run requires command as string or argv array");
    error.code = "INVALID_PARAMS";
    throw error;
  }

  if (argv.length === 0) {
    const error = new Error("system.run command array cannot be empty");
    error.code = "INVALID_PARAMS";
    throw error;
  }

  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (envNameAllowed(name, config) && !envNameDenied(name, config)) {
      env[name] = value;
    }
  }

  for (const [name, value] of Object.entries(envOverrides)) {
    if (!envNameDenied(name, config) && envNameAllowed(name, config)) {
      env[name] = value;
    }
  }

  const resolvedBinary = await whichCommand(argv[0], process.env.PATH, cwd);
  const spawnCommand = resolvedBinary || argv[0];

  return {
    agentId: rawParams.agentId || rawParams.agent || null,
    cwd,
    argv,
    spawnCommand,
    env,
    timeoutMs,
    isShellText,
    resolvedBinary: resolvedBinary ? normalizeMatchPath(resolvedBinary) : null,
    binaryName: path.basename(argv[0]),
    displayCommand: isShellText ? commandValue : argv.join(" ")
  };
}

export async function executeRun(plan, config) {
  await fs.mkdir(plan.cwd, { recursive: true });

  const startedAt = Date.now();
  const child = spawn(plan.spawnCommand || plan.argv[0], plan.argv.slice(1), {
    cwd: plan.cwd,
    env: plan.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const stdout = createOutputCollector(config.runner.maxOutputBytes);
  const stderr = createOutputCollector(config.runner.maxOutputBytes);
  let timedOut = false;
  let killed = false;

  child.stdout.on("data", (chunk) => {
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr.push(chunk);
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    killed = child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 5000).unref();
  }, plan.timeoutMs);

  const { exitCode, signal } = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, closeSignal) => resolve({ exitCode: code, signal: closeSignal }));
  }).finally(() => {
    clearTimeout(timeout);
  });

  return {
    stdout: stdout.toString(),
    stderr: stderr.toString(),
    exitCode: exitCode ?? (signal ? 1 : 0),
    signal,
    timedOut,
    killed,
    durationMs: Date.now() - startedAt,
    cwd: plan.cwd,
    argv: plan.argv,
    resolvedBinary: plan.resolvedBinary
  };
}
