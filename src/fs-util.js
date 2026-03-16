import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function expandHome(value) {
  if (!value || !value.startsWith("~")) {
    return value;
  }

  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

export function toPosixPath(value) {
  return value.replace(/\\/g, "/");
}

export function normalizeMatchPath(value) {
  const isWindowsDrivePath = /^[A-Za-z]:[\\/]/.test(value);
  const isUncPath = value.startsWith("\\\\");
  const resolved = isWindowsDrivePath || isUncPath ? value : path.resolve(value);
  const normalized = toPosixPath(resolved).replace(/\/+/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function parseJsonText(
  raw,
  { filePath, context, details = {}, errorCode = "INVALID_JSON", errorMessage = "invalid JSON" } = {}
) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      const subject = filePath || context || "unknown";
      const wrapped = new Error(`${errorMessage}: ${subject}`);
      wrapped.code = errorCode;
      wrapped.details = {
        ...(filePath ? { filePath } : {}),
        ...(context ? { context } : {}),
        ...details
      };
      wrapped.cause = error;
      throw wrapped;
    }

    throw error;
  }
}

export async function readJsonFile(filePath, fallback = null, options = {}) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseJsonText(raw, { filePath, ...options });
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function readTextFile(filePath, fallback = null) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function writeTextFileAtomic(filePath, contents) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, contents, "utf8");
  await fs.rename(tempPath, filePath);
}

export async function writeJsonFileAtomic(filePath, value) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  await writeTextFileAtomic(filePath, contents);
}

export function stableJson(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stableJson(entry));
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((accumulator, key) => {
        accumulator[key] = stableJson(value[key]);
        return accumulator;
      }, {});
  }

  return value;
}

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function sha256Base64Url(value) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}
