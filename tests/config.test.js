import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { loadConfig } from "../src/config.js";
import { readJsonFile } from "../src/fs-util.js";

test("config resolves relative policy paths against config directory", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "secure-node-config-"));
  const configPath = path.join(tempDir, "secure-node.config.json");
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
              cwd: ["./workspace/**"]
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

  assert.equal(config.storage.dir, path.join(tempDir, ".state"));
  assert.equal(config.policy.denyPaths[0], path.join(tempDir, "secret/**"));
  assert.equal(config.policy.commandRules[0].match.binary[0], path.join(tempDir, "bin/tool"));
  assert.equal(config.policy.commandRules[0].cwd[0], path.join(tempDir, "workspace/**"));
});

test("config fails closed on malformed JSON", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "secure-node-config-"));
  const configPath = path.join(tempDir, "secure-node.config.json");
  await fs.writeFile(configPath, "{not valid json", "utf8");

  await assert.rejects(
    loadConfig(configPath, { readJsonFile }),
    (error) => error.code === "INVALID_CONFIG_JSON" && error.details?.filePath === configPath
  );
});
