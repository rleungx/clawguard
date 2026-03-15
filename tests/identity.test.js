import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { loadOrCreateIdentity } from "../src/identity.js";

test("identity loading fails closed on malformed JSON state", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "secure-node-identity-"));
  const statePath = path.join(tempDir, "state.json");
  const malformedState = "{not valid json";
  await fs.writeFile(statePath, malformedState, "utf8");

  await assert.rejects(
    loadOrCreateIdentity(statePath),
    (error) => error.code === "INVALID_IDENTITY_STATE_JSON" && error.details?.filePath === statePath
  );

  assert.equal(await fs.readFile(statePath, "utf8"), malformedState);
});
