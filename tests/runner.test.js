import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { executeRun, normalizeRunPlan } from "../src/runner.js";

test("runner executes an allowed argv command and captures output", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawguard-runner-"));
  const config = {
    policy: {
      envAllowlist: ["LANG", "TERM"],
      denyEnvPrefixes: ["PATH", "LD_"]
    },
    runner: {
      defaultCwd: tempDir,
      shell: process.env.SHELL || "/bin/zsh",
      maxOutputBytes: 65536
    }
  };

  const plan = await normalizeRunPlan(
    {
      command: [process.execPath, "-e", "console.log('runner-ok')"],
      cwd: tempDir
    },
    config
  );

  const result = await executeRun(plan, config);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /runner-ok/);
});

test("runner executes a bare command name after resolving it from PATH", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawguard-runner-"));
  const config = {
    policy: {
      envAllowlist: ["LANG", "TERM"],
      denyEnvPrefixes: ["PATH", "LD_"]
    },
    runner: {
      defaultCwd: tempDir,
      shell: process.env.SHELL || "/bin/zsh",
      maxOutputBytes: 65536
    }
  };

  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${previousPath || ""}`;

    const plan = await normalizeRunPlan(
      {
        command: [path.basename(process.execPath), "-e", "console.log('runner-bare-ok')"],
        cwd: tempDir
      },
      config
    );

    const result = await executeRun(plan, config);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /runner-bare-ok/);
    assert.equal(plan.spawnCommand, plan.resolvedBinary);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("runner truncates oversized stdout while preserving the cap marker", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawguard-runner-"));
  const config = {
    policy: {
      envAllowlist: ["LANG", "TERM"],
      denyEnvPrefixes: ["PATH", "LD_"]
    },
    runner: {
      defaultCwd: tempDir,
      shell: process.env.SHELL || "/bin/zsh",
      maxOutputBytes: 32
    }
  };

  const plan = await normalizeRunPlan(
    {
      command: [process.execPath, "-e", "process.stdout.write('A'.repeat(96)); process.stdout.write('TAIL')"],
      cwd: tempDir
    },
    config
  );

  const result = await executeRun(plan, config);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /output truncated to 32 bytes/);
  assert.doesNotMatch(result.stdout, /TAIL/);
});

test("runner truncates oversized stderr while preserving the cap marker", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawguard-runner-"));
  const config = {
    policy: {
      envAllowlist: ["LANG", "TERM"],
      denyEnvPrefixes: ["PATH", "LD_"]
    },
    runner: {
      defaultCwd: tempDir,
      shell: process.env.SHELL || "/bin/zsh",
      maxOutputBytes: 32
    }
  };

  const plan = await normalizeRunPlan(
    {
      command: [process.execPath, "-e", "process.stderr.write('B'.repeat(96)); process.stderr.write('TAIL')"],
      cwd: tempDir
    },
    config
  );

  const result = await executeRun(plan, config);

  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /output truncated to 32 bytes/);
  assert.doesNotMatch(result.stderr, /TAIL/);
});
