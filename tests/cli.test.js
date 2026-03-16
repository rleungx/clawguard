import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { runCli } from "../src/cli.js";

test("cli init-config copies the packaged example config", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawguard-cli-"));
  const configPath = path.join(tempDir, "config.json");
  const originalLog = console.log;
  const logs = [];
  console.log = (message) => {
    logs.push(message);
  };

  try {
    await runCli(["init-config", "--config", configPath]);
  } finally {
    console.log = originalLog;
  }

  const content = await fs.readFile(configPath, "utf8");
  assert.match(content, /"gateway"/);
  assert.equal(logs[0], configPath);
});

test("cli init-config refuses to overwrite without force", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawguard-cli-"));
  const configPath = path.join(tempDir, "config.json");
  await fs.writeFile(configPath, "original", "utf8");

  await assert.rejects(
    runCli(["init-config", "--config", configPath]),
    (error) => error.code === "CONFIG_EXISTS"
  );

  assert.equal(await fs.readFile(configPath, "utf8"), "original");
});
