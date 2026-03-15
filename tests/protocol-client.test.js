import test from "node:test";
import assert from "node:assert/strict";

import { PROTOCOL_VERSION } from "../src/constants.js";
import { ProtocolClient } from "../src/protocol-client.js";

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor() {
    this.readyState = FakeWebSocket.OPEN;
    this.sentFrames = [];
    this.listeners = new Map();
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
}

function createClient(overrides = {}) {
  return new ProtocolClient({
    gatewayUrl: "ws://127.0.0.1:18789",
    gatewayToken: null,
    openTimeoutMs: 20,
    eventTimeoutMs: 20,
    requestTimeoutMs: 20,
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
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;

  try {
    const client = createClient();
    client.socket = new FakeWebSocket();

    await assert.rejects(client.sendRequest("connect", {}), (error) => error.code === "REQUEST_TIMEOUT");
    assert.equal(client.pending.size, 0);
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("protocol client emits a structured error for malformed websocket frame JSON", async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
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
    globalThis.WebSocket = originalWebSocket;
  }
});

test("protocol client completes handshake and persists returned device token", async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
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
    assert.equal(connectFrame.params.protocolVersion, PROTOCOL_VERSION);
    assert.equal(connectFrame.params.role.type, "node");
    assert.deepEqual(connectFrame.params.role.commands, ["system.which"]);
    assert.equal(connectFrame.params.role.browserToolsEnabled, true);
    assert.equal(connectFrame.params.role.browserProxyEnabled, true);
    assert.equal(connectFrame.params.auth.token, "gateway-token");

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
    globalThis.WebSocket = originalWebSocket;
  }
});
