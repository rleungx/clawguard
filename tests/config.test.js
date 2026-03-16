import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { loadConfig } from "../src/config.js";
import { readJsonFile } from "../src/fs-util.js";

test("config resolves relative policy paths against config directory", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawguard-config-"));
  const configDir = path.join(tempDir, ".clawguard");
  const configPath = path.join(configDir, "clawguard.config.json");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        storage: {
          dir: ".state"
        },
        policy: {
          denyPaths: ["./secret/**"],
          commandRules: [
            {
              action: "allow",
              match: {
                binary: ["./bin/tool"]
              },
              cwd: ["./workspace/**", "../**"]
            }
          ]
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const config = await loadConfig(configPath, { readJsonFile });

  assert.equal(config.storage.dir, path.join(configDir, ".state"));
  assert.equal(config.policy.denyPaths[0], path.join(configDir, "secret/**"));
  assert.equal(config.policy.commandRules[0].match.binary[0], path.join(configDir, "bin/tool"));
  assert.equal(config.policy.commandRules[0].cwd[0], path.join(configDir, "workspace/**"));
  assert.equal(config.policy.commandRules[0].cwd[1], `${tempDir}/**`);
});

test("config fails closed on malformed JSON", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawguard-config-"));
  const configPath = path.join(tempDir, "clawguard.config.json");
  await fs.writeFile(configPath, "{not valid json", "utf8");

  await assert.rejects(
    loadConfig(configPath, { readJsonFile }),
    (error) => error.code === "INVALID_CONFIG_JSON" && error.details?.filePath === configPath
  );
});

test("config defaults handshake profile to auto and allows override", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawguard-config-"));
  const defaultConfigPath = path.join(tempDir, "default.config.json");
  const legacyConfigPath = path.join(tempDir, "legacy.config.json");

  await fs.writeFile(defaultConfigPath, JSON.stringify({}, null, 2), "utf8");
  await fs.writeFile(
    legacyConfigPath,
    JSON.stringify({ gateway: { handshakeProfile: "legacy" } }, null, 2),
    "utf8"
  );

  const defaultConfig = await loadConfig(defaultConfigPath, { readJsonFile });
  const legacyConfig = await loadConfig(legacyConfigPath, { readJsonFile });

  assert.equal(defaultConfig.gateway.handshakeProfile, "auto");
  assert.equal(legacyConfig.gateway.handshakeProfile, "legacy");
});

test("config rejects invalid gateway settings", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawguard-config-"));
  const configPath = path.join(tempDir, "invalid.config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        gateway: {
          url: "http://127.0.0.1:18789",
          reconnectMs: -1
        }
      },
      null,
      2
    ),
    "utf8"
  );

  await assert.rejects(
    loadConfig(configPath, { readJsonFile }),
    (error) => error.code === "INVALID_CONFIG" && error.details?.key === "gateway.url"
  );
});

test("config rejects invalid handshake profiles", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawguard-config-"));
  const configPath = path.join(tempDir, "invalid-profile.config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        gateway: {
          handshakeProfile: "future"
        }
      },
      null,
      2
    ),
    "utf8"
  );

  await assert.rejects(
    loadConfig(configPath, { readJsonFile }),
    (error) => error.code === "INVALID_CONFIG" && error.details?.key === "gateway.handshakeProfile"
  );
});

test("config rejects invalid logging levels", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawguard-config-"));
  const configPath = path.join(tempDir, "invalid-logging.config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        logging: {
          level: "debug"
        }
      },
      null,
      2
    ),
    "utf8"
  );

  await assert.rejects(
    loadConfig(configPath, { readJsonFile }),
    (error) => error.code === "INVALID_CONFIG" && error.details?.key === "logging.level"
  );
});
