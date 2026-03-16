import test from "node:test";
import assert from "node:assert/strict";

import { evaluatePolicy } from "../src/policy.js";

const baseConfig = {
  policy: {
    defaultAction: "deny",
    allowShellText: false,
    denyPaths: ["/tmp/secret/**"],
    commandRules: [
      {
        id: "allow-git-status",
        action: "allow",
        match: {
          binary: ["/usr/bin/git"],
          argvIncludes: ["status"]
        },
        cwd: ["/workspace/**"]
      }
    ]
  }
};

test("policy allows a matching command rule", () => {
  const decision = evaluatePolicy(baseConfig, {
    cwd: "/workspace/project",
    argv: ["git", "status"],
    resolvedBinary: "/usr/bin/git",
    binaryName: "git",
    isShellText: false
  });

  assert.equal(decision.action, "allow");
});

test("policy allows a matching command rule from the rule root cwd", () => {
  const decision = evaluatePolicy(baseConfig, {
    cwd: "/workspace",
    argv: ["git", "status"],
    resolvedBinary: "/usr/bin/git",
    binaryName: "git",
    isShellText: false
  });

  assert.equal(decision.action, "allow");
});

test("policy normalizes cwd before matching configured patterns", () => {
  const decision = evaluatePolicy(
    {
      policy: {
        defaultAction: "deny",
        allowShellText: false,
        denyPaths: [],
        commandRules: [
          {
            action: "allow",
            match: {
              binary: ["git"]
            },
            cwd: ["C:/workspace/**"]
          }
        ]
      }
    },
    {
      cwd: "C:\\workspace\\project",
      argv: ["git", "status"],
      resolvedBinary: null,
      binaryName: "git",
      isShellText: false
    }
  );

  assert.equal(decision.action, "allow");
});

test("policy denies shell text when disabled", () => {
  const decision = evaluatePolicy(baseConfig, {
    cwd: "/workspace/project",
    argv: ["/bin/zsh", "-lc", "git status"],
    resolvedBinary: "/bin/zsh",
    binaryName: "zsh",
    isShellText: true
  });

  assert.equal(decision.action, "deny");
});

test("policy denies touching denied paths", () => {
  const decision = evaluatePolicy(baseConfig, {
    cwd: "/workspace/project",
    argv: ["cat", "/tmp/secret/key.txt"],
    resolvedBinary: "/bin/cat",
    binaryName: "cat",
    isShellText: false
  });

  assert.equal(decision.action, "deny");
});

test("policy denies using a denied cwd root", () => {
  const decision = evaluatePolicy(baseConfig, {
    cwd: "/tmp/secret",
    argv: ["cat", "notes.txt"],
    resolvedBinary: "/bin/cat",
    binaryName: "cat",
    isShellText: false
  });

  assert.equal(decision.action, "deny");
});
