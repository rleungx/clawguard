import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { loadOrCreateIdentity } from "../src/identity.js";

test("identity loading fails closed on malformed JSON state", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawguard-identity-"));
  const statePath = path.join(tempDir, "state.json");
  const malformedState = "{not valid json";
  await fs.writeFile(statePath, malformedState, "utf8");

  await assert.rejects(
    loadOrCreateIdentity(statePath),
    (error) => error.code === "INVALID_IDENTITY_STATE_JSON" && error.details?.filePath === statePath
  );

  assert.equal(await fs.readFile(statePath, "utf8"), malformedState);
});

test("identity signs modern and legacy device payloads differently", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawguard-identity-"));
  const statePath = path.join(tempDir, "state.json");
  const originalNow = Date.now;
  Date.now = () => 1700000000000;

  try {
    const identity = await loadOrCreateIdentity(statePath);
    const publicKey = crypto.createPublicKey({
      key: {
        crv: "Ed25519",
        kty: "OKP",
        x: identity.publicKeyBase64Url
      },
      format: "jwk"
    });

    const baseParams = {
      nonce: "nonce-1",
      token: "gateway-token",
      clientId: "node-host",
      clientMode: "node",
      role: "node",
      scopes: ["scope-a", "scope-b"],
      platform: "  Darwin  ",
      deviceFamily: "  Desktop  "
    };

    const modern = identity.buildSignedDevice({
      ...baseParams,
      profile: "modern"
    });
    const legacy = identity.buildSignedDevice({
      ...baseParams,
      profile: "legacy"
    });

    const v2Payload = `v2|${identity.deviceId}|node-host|node|node|scope-a,scope-b|1700000000000|gateway-token|nonce-1`;
    const v3Payload = `v3|${identity.deviceId}|node-host|node|node|scope-a,scope-b|1700000000000|gateway-token|nonce-1|darwin|desktop`;

    assert.equal(modern.id, identity.deviceId);
    assert.equal(legacy.id, identity.deviceId);
    assert.equal(modern.publicKey, identity.publicKeyBase64Url);
    assert.equal(legacy.publicKey, identity.publicKeyBase64Url);
    assert.equal(modern.signedAt, 1700000000000);
    assert.equal(legacy.signedAt, 1700000000000);
    assert.equal(modern.nonce, "nonce-1");
    assert.equal(legacy.nonce, "nonce-1");
    assert.notEqual(modern.signature, legacy.signature);

    assert.equal(crypto.verify(null, Buffer.from(v3Payload), publicKey, Buffer.from(modern.signature, "base64url")), true);
    assert.equal(crypto.verify(null, Buffer.from(v2Payload), publicKey, Buffer.from(modern.signature, "base64url")), false);
    assert.equal(crypto.verify(null, Buffer.from(v2Payload), publicKey, Buffer.from(legacy.signature, "base64url")), true);
    assert.equal(crypto.verify(null, Buffer.from(v3Payload), publicKey, Buffer.from(legacy.signature, "base64url")), false);
  } finally {
    Date.now = originalNow;
  }
});
