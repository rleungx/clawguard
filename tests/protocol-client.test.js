import test from "node:test";
import assert from "node:assert/strict";

import { PROTOCOL_VERSION } from "../src/constants.js";
import { ProtocolClient } from "../src/protocol-client.js";

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url, protocols, options) {
    this.readyState = FakeWebSocket.OPEN;
    this.sentFrames = [];
    this.listeners = new Map();
    this.url = url;
    this.protocols = protocols;
    this.options = options;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(eventName, handler) {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, []);
    }
    this.listeners.get(eventName).push(handler);
  }

  removeEventListener(eventName, handler) {
    if (!this.listeners.has(eventName)) {
      return;
    }

    this.listeners.set(
      eventName,
      this.listeners.get(eventName).filter((entry) => entry !== handler)
    );
  }

  emit(eventName, payload) {
    for (const handler of this.listeners.get(eventName) || []) {
      handler(payload);
    }
  }

  send(frame) {
    this.sentFrames.push(JSON.parse(frame));
  }

  close() {
    this.readyState = 3;
  }
}

function createClient(overrides = {}) {
  return new ProtocolClient({
    gatewayUrl: "ws://127.0.0.1:18789",
    gatewayToken: null,
    openTimeoutMs: 20,
    eventTimeoutMs: 20,
    requestTimeoutMs: 20,
    webSocketImpl: FakeWebSocket,
    identity: {
      nodeId: "node-1",
      deviceToken: null,
      buildSignedDevice() {
        return {};
      },
      async persistDeviceToken() {}
    },
    nodeInfo: {
      displayName: "node-1",
      platform: process.platform,
      deviceFamily: "headless",
      commands: [],
      caps: [],
      permissions: {}
    },
    auditLogger: {
      async write() {}
    },
    ...overrides
  });
}

test("protocol client times out waiting for an event", async () => {
  const client = createClient();

  await assert.rejects(client.waitForEvent("connect.challenge"), (error) => error.code === "EVENT_TIMEOUT");
});

test("protocol client times out a pending request and clears it", async () => {
  try {
    const client = createClient();
    client.socket = new FakeWebSocket();

    await assert.rejects(client.sendRequest("connect", {}), (error) => error.code === "REQUEST_TIMEOUT");
    assert.equal(client.pending.size, 0);
  } finally {
    FakeWebSocket.instances.length = 0;
  }
});

test("protocol client emits a structured error for malformed websocket frame JSON", async () => {
  FakeWebSocket.instances.length = 0;

  try {
    const client = createClient();
    const connectPromise = client.connect().catch(() => {});
    const socket = FakeWebSocket.instances[0];

    let receivedError;
    client.on("error", (error) => {
      receivedError = error;
    });

    socket.emit("message", { data: "{not valid json" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await connectPromise;

    assert.equal(receivedError?.code, "INVALID_FRAME_JSON");
    assert.equal(receivedError?.details?.source, "websocket.message");
    assert.equal(receivedError?.details?.context, "websocket.message");
  } finally {
    FakeWebSocket.instances.length = 0;
  }
});

test("protocol client reports malformed frames without crashing when no error listener is attached", async () => {
  FakeWebSocket.instances.length = 0;

  const client = createClient({ openTimeoutMs: 10 });
  let reportedError;
  client.on("protocol-error", (error) => {
    reportedError = error;
  });

  const connectPromise = client.connect();
  const socket = FakeWebSocket.instances[0];

  socket.emit("message", { data: "{not valid json" });

  await assert.rejects(connectPromise, (error) => error.code === "WEBSOCKET_OPEN_TIMEOUT");
  assert.equal(reportedError?.code, "INVALID_FRAME_JSON");
});

test("protocol client completes handshake and persists returned device token", async () => {
  FakeWebSocket.instances.length = 0;

  const persistedTokens = [];

  try {
    const client = createClient({
      gatewayToken: "gateway-token",
      identity: {
        nodeId: "node-1",
        deviceToken: null,
        buildSignedDevice({ nonce, token, clientId, clientMode, role, scopes }) {
          return {
            id: "node-1",
            publicKey: "public-key",
            signature: "signature",
            signedAt: 123,
            nonce,
            token,
            clientId,
            clientMode,
            role,
            scopes
          };
        },
        async persistDeviceToken(deviceToken) {
          persistedTokens.push(deviceToken);
        }
      },
      nodeInfo: {
        displayName: "node-1",
        platform: process.platform,
        deviceFamily: "headless",
        commands: ["system.which"],
        caps: ["system"],
        permissions: { exec: true },
        browserToolsEnabled: true,
        browserProxyEnabled: true
      }
    });

    const connectPromise = client.connect();
    const socket = FakeWebSocket.instances[0];

    socket.emit("open");
    socket.emit("message", {
      data: JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-1" }
      })
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const connectFrame = socket.sentFrames[0];
    assert.equal(connectFrame.method, "connect");
    assert.equal(connectFrame.params.minProtocol, PROTOCOL_VERSION);
    assert.equal(connectFrame.params.maxProtocol, PROTOCOL_VERSION);
    assert.equal(connectFrame.params.role, "node");
    assert.equal(connectFrame.params.auth.token, "gateway-token");
    assert.equal(socket.options.headers.Authorization, "Bearer gateway-token");

    socket.emit("message", {
      data: JSON.stringify({
        type: "res",
        id: connectFrame.id,
        ok: true,
        payload: {
          protocol: PROTOCOL_VERSION,
          auth: { deviceToken: "persisted-device-token" }
        }
      })
    });

    const result = await connectPromise;
    assert.equal(result.protocol, PROTOCOL_VERSION);
    assert.deepEqual(persistedTokens, ["persisted-device-token"]);
  } finally {
    FakeWebSocket.instances.length = 0;
  }
});

test("protocol client passes profile and platform metadata into device signing", async () => {
  FakeWebSocket.instances.length = 0;

  const signingCalls = [];

  const client = createClient({
    handshakeProfile: "modern",
    identity: {
      nodeId: "node-1",
      deviceToken: null,
      buildSignedDevice(params) {
        signingCalls.push(params);
        return {
          id: "node-1",
          publicKey: "public-key",
          signature: "signature",
          signedAt: 123,
          nonce: params.nonce
        };
      },
      async persistDeviceToken() {}
    },
    nodeInfo: {
      displayName: "node-1",
      platform: "darwin",
      deviceFamily: "desktop",
      commands: [],
      caps: [],
      permissions: {}
    }
  });

  const connectPromise = client.connect();
  const socket = FakeWebSocket.instances[0];

  socket.emit("open");
  socket.emit("message", {
    data: JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-1" }
    })
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(signingCalls[0], {
    nonce: "nonce-1",
    token: null,
    clientId: "node-host",
    clientMode: "node",
    role: "node",
    scopes: [],
    platform: "darwin",
    deviceFamily: "desktop",
    profile: "modern"
  });

  const connectFrame = socket.sentFrames[0];
  socket.emit("message", {
    data: JSON.stringify({
      type: "res",
      id: connectFrame.id,
      ok: true,
      payload: { protocol: PROTOCOL_VERSION }
    })
  });

  const result = await connectPromise;
  assert.equal(result.protocol, PROTOCOL_VERSION);
});

test("protocol client falls back to legacy handshake on schema mismatch", async () => {
  FakeWebSocket.instances.length = 0;

  const client = createClient({
    handshakeProfile: "auto",
    identity: {
      nodeId: "node-1",
      deviceToken: null,
      buildSignedDevice({ nonce, profile }) {
        return {
          id: `${profile}-node-1`,
          publicKey: "public-key",
          signature: `${profile}-signature`,
          signedAt: 123,
          nonce
        };
      },
      async persistDeviceToken() {}
    }
  });

  const connectPromise = client.connect();
  const modernSocket = FakeWebSocket.instances[0];

  modernSocket.emit("open");
  modernSocket.emit("message", {
    data: JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-modern" }
    })
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  const modernFrame = modernSocket.sentFrames[0];
  assert.equal(modernFrame.params.device.id, "modern-node-1");

  modernSocket.emit("message", {
    data: JSON.stringify({
      type: "res",
      id: modernFrame.id,
      ok: false,
      error: {
        code: "INVALID_PARAMS",
        message: "unexpected property 'protocolVersion'"
      }
    })
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  const legacySocket = FakeWebSocket.instances[1];
  legacySocket.emit("open");
  legacySocket.emit("message", {
    data: JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-legacy" }
    })
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  const legacyFrame = legacySocket.sentFrames[0];
  assert.equal(legacyFrame.params.device.id, "legacy-node-1");
  assert.equal(legacyFrame.params.role, "node");

  legacySocket.emit("message", {
    data: JSON.stringify({
      type: "res",
      id: legacyFrame.id,
      ok: true,
      payload: { protocol: PROTOCOL_VERSION }
    })
  });

  const result = await connectPromise;
  assert.equal(result.protocol, PROTOCOL_VERSION);
  assert.equal(client.preferredHandshakeProfile, "legacy");
});

test("protocol client waits for challenge nonce after session.welcome", async () => {
  FakeWebSocket.instances.length = 0;

  const signingCalls = [];
  const client = createClient({
    identity: {
      nodeId: "node-1",
      deviceToken: null,
      buildSignedDevice(params) {
        signingCalls.push(params);
        return {
          id: "node-1",
          publicKey: "public-key",
          signature: "signature",
          signedAt: 123,
          nonce: params.nonce
        };
      },
      async persistDeviceToken() {}
    }
  });

  const connectPromise = client.connect();
  const socket = FakeWebSocket.instances[0];

  socket.emit("open");
  socket.emit("message", {
    data: JSON.stringify({
      type: "event",
      event: "session.welcome",
      payload: { protocol: PROTOCOL_VERSION }
    })
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(socket.sentFrames.length, 0);
  assert.equal(signingCalls.length, 0);

  socket.emit("message", {
    data: JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-after-welcome" }
    })
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  const connectFrame = socket.sentFrames[0];
  assert.equal(connectFrame.method, "connect");
  assert.equal(connectFrame.params.device.nonce, "nonce-after-welcome");
  assert.equal(signingCalls[0].nonce, "nonce-after-welcome");

  socket.emit("message", {
    data: JSON.stringify({
      type: "res",
      id: connectFrame.id,
      ok: true,
      payload: { protocol: PROTOCOL_VERSION }
    })
  });

  const result = await connectPromise;
  assert.equal(result.protocol, PROTOCOL_VERSION);
});

test("protocol client does not send responses on a closed socket", () => {
  const client = createClient();
  client.socket = new FakeWebSocket();
  client.socket.readyState = 3;

  assert.equal(client.sendResponse("req-1", { ok: true }), false);
  assert.equal(client.sendError("req-1", new Error("boom")), false);
  assert.equal(client.socket.sentFrames.length, 0);
});

test("protocol client close closes the live socket and clears it", () => {
  const client = createClient();
  const socket = new FakeWebSocket();
  client.socket = socket;

  assert.equal(client.close(), true);
  assert.equal(socket.readyState, 3);
  assert.equal(client.socket, null);
  assert.equal(client.close(), false);
});
