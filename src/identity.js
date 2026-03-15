import crypto from "node:crypto";

import { readJsonFile, sha256Hex, writeJsonFileAtomic } from "./fs-util.js";

function exportPrivateKeyPem(privateKey) {
  return privateKey.export({ format: "pem", type: "pkcs8" });
}

function buildPublicKeyBase64Url(privateKeyPem) {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const publicKey = crypto.createPublicKey(privateKey);
  const jwk = publicKey.export({ format: "jwk" });
  return jwk.x;
}

function buildDeviceId(publicKeyBase64Url) {
  return `secure-node-${sha256Hex(publicKeyBase64Url).slice(0, 12)}`;
}

function buildSignaturePayload({
  deviceId,
  clientId,
  clientMode,
  role,
  scopes,
  signedAt,
  token,
  nonce
}) {
  const scopeString = [...scopes].sort().join(",");
  return `v2|${deviceId}|${clientId}|${clientMode}|${role}|${scopeString}|${signedAt}|${token}|${nonce}`;
}

export async function loadOrCreateIdentity(statePath, configuredDeviceId = null) {
  let state = await readJsonFile(statePath, null, {
    errorCode: "INVALID_IDENTITY_STATE_JSON",
    errorMessage: "invalid identity state JSON"
  });

  if (!state?.privateKeyPem) {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const privateKeyPem = exportPrivateKeyPem(privateKey);
    const publicKeyBase64Url = buildPublicKeyBase64Url(privateKeyPem);
    state = {
      privateKeyPem,
      publicKeyBase64Url,
      deviceId: configuredDeviceId || buildDeviceId(publicKeyBase64Url),
      deviceToken: null
    };
    await writeJsonFileAtomic(statePath, state);
  }

  if (!state.publicKeyBase64Url) {
    state.publicKeyBase64Url = buildPublicKeyBase64Url(state.privateKeyPem);
  }

  if (!state.deviceId && state.nodeId) {
    state.deviceId = state.nodeId;
  }

  if (!state.deviceId) {
    state.deviceId = configuredDeviceId || buildDeviceId(state.publicKeyBase64Url);
  }

  if (configuredDeviceId && state.deviceId !== configuredDeviceId) {
    state.deviceId = configuredDeviceId;
  }

  await writeJsonFileAtomic(statePath, state);

  return {
    nodeId: state.deviceId,
    deviceId: state.deviceId,
    publicKeyBase64Url: state.publicKeyBase64Url,
    privateKeyPem: state.privateKeyPem,
    deviceToken: state.deviceToken || null,
    async persistDeviceToken(deviceToken) {
      if (!deviceToken || deviceToken === state.deviceToken) {
        return;
      }

      state.deviceToken = deviceToken;
      await writeJsonFileAtomic(statePath, state);
    },
    buildSignedDevice({ nonce, token, clientId, clientMode = "node", role = "node", scopes = [] }) {
      const signedAt = Date.now();
      const payload = buildSignaturePayload({
        deviceId: state.deviceId,
        clientId,
        clientMode,
        role,
        scopes,
        signedAt: String(signedAt),
        token: token || "",
        nonce
      });
      const signature = crypto.sign(null, Buffer.from(payload), state.privateKeyPem).toString("base64url");

      return {
        id: state.deviceId,
        publicKey: state.publicKeyBase64Url,
        signature,
        signedAt,
        nonce
      };
    }
  };
}
