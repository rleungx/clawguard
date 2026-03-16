import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { WebSocket as NodeWebSocket } from "ws";

import { APP_ID, APP_VERSION, OPENCLAW_NODE_HOST_CLIENT_ID, PROTOCOL_VERSION } from "./constants.js";
import { parseJsonText } from "./fs-util.js";

const HANDSHAKE_PROFILE_MODERN = "modern";
const HANDSHAKE_PROFILE_LEGACY = "legacy";

function normalizeHandshakeProfile(value) {
  return value === HANDSHAKE_PROFILE_LEGACY || value === HANDSHAKE_PROFILE_MODERN ? value : "auto";
}

function protocolError(message, code = "PROTOCOL_ERROR", details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function buildClientMetadata(nodeInfo, profile) {
  return {
    id: OPENCLAW_NODE_HOST_CLIENT_ID,
    displayName: nodeInfo.displayName,
    version: APP_VERSION,
    platform: nodeInfo.platform,
    mode: "node",
    instanceId: crypto.randomUUID(),
    ...(profile === HANDSHAKE_PROFILE_MODERN && nodeInfo.deviceFamily ? { deviceFamily: nodeInfo.deviceFamily } : {})
  };
}

function handshakeErrorText(error) {
  return `${error?.message || ""} ${JSON.stringify(error?.details || {})}`.toLowerCase();
}

function isHandshakeSchemaMismatch(error) {
  if (!error) {
    return false;
  }

  if (error.code === "INVALID_PARAMS") {
    return true;
  }

  if (error.code === "INVALID_REQUEST") {
    return true;
  }

  const text = handshakeErrorText(error);
  return [
    "unexpected property",
    "must be string",
    "must be equal to constant",
    "missing publickey",
    "missing signature",
    "missing signedat",
    "missing nonce",
    "invalid connect params",
    "device identity mismatch"
  ].some((snippet) => text.includes(snippet));
}

function frameType(frame) {
  return frame?.type || frame?.t;
}

function frameEvent(frame) {
  return frame?.event || frame?.method;
}

function framePayload(frame) {
  return frame?.payload ?? frame?.params ?? frame?.result;
}

export class ProtocolClient extends EventEmitter {
  constructor({
    gatewayUrl,
    gatewayToken,
    openTimeoutMs = 10000,
    eventTimeoutMs = 10000,
    requestTimeoutMs = 15000,
    handshakeProfile = "auto",
    webSocketImpl = NodeWebSocket,
    identity,
    nodeInfo,
    auditLogger
  }) {
    super();
    this.gatewayUrl = gatewayUrl;
    this.gatewayToken = gatewayToken;
    this.openTimeoutMs = openTimeoutMs;
    this.eventTimeoutMs = eventTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.handshakeProfile = normalizeHandshakeProfile(handshakeProfile);
    this.preferredHandshakeProfile = this.handshakeProfile === HANDSHAKE_PROFILE_LEGACY ? HANDSHAKE_PROFILE_LEGACY : HANDSHAKE_PROFILE_MODERN;
    this.webSocketImpl = webSocketImpl;
    this.identity = identity;
    this.nodeInfo = nodeInfo;
    this.auditLogger = auditLogger;
    this.socket = null;
    this.pending = new Map();
    this.seenEvents = new Map();
  }

  reportError(error) {
    if (this.listenerCount("error") > 0) {
      this.emit("error", error);
      return;
    }

    this.emit("protocol-error", error);
  }

  async connect() {
    const profiles = this.resolveHandshakeProfiles();
    let lastError = null;

    for (const profile of profiles) {
      try {
        const connectResult = await this.connectWithProfile(profile);
        this.preferredHandshakeProfile = profile;
        return connectResult;
      } catch (error) {
        lastError = error;
        if (this.handshakeProfile === "auto" && profile === HANDSHAKE_PROFILE_MODERN && isHandshakeSchemaMismatch(error)) {
          continue;
        }
        throw error;
      }
    }

    throw lastError;
  }

  async connectWithProfile(profile) {
    const wsOptions = {};
    const gatewayToken = this.gatewayToken || this.identity.deviceToken || null;
    if (gatewayToken) {
      wsOptions.headers = {
        Authorization: `Bearer ${gatewayToken}`
      };
    }

    this.seenEvents.clear();
    this.pending.clear();

    const WebSocketImpl = this.webSocketImpl;
    const socket = new WebSocketImpl(this.gatewayUrl, [], wsOptions);
    this.socket = socket;
    let onOpen;
    let onError;

    try {
      socket.addEventListener("message", async (event) => {
        try {
          const frame = parseJsonText(String(event.data), {
            context: "websocket.message",
            errorCode: "INVALID_FRAME_JSON",
            errorMessage: "invalid websocket frame JSON",
            details: {
              source: "websocket.message"
            }
          });
          await this.handleFrame(frame);
        } catch (error) {
          this.reportError(error);
        }
      });

      socket.addEventListener("close", (event) => {
        for (const pending of this.pending.values()) {
          pending.reject(protocolError("gateway connection closed", "CONNECTION_CLOSED"));
        }
        this.pending.clear();
        this.emit("close", event);
      });

      socket.addEventListener("error", (event) => {
        this.reportError(protocolError("websocket error", "WEBSOCKET_ERROR", event));
      });

      await this.withTimeout(
        new Promise((resolve, reject) => {
          onOpen = () => resolve();
          onError = () => reject(protocolError("failed to open websocket", "WEBSOCKET_OPEN_FAILED"));
          socket.addEventListener("open", onOpen, { once: true });
          socket.addEventListener("error", onError, { once: true });
        }),
        this.openTimeoutMs,
        () => protocolError("timed out opening websocket", "WEBSOCKET_OPEN_TIMEOUT"),
        () => {
          socket.removeEventListener?.("open", onOpen);
          socket.removeEventListener?.("error", onError);
        }
      );

      const initialHandshakeEvent = await this.waitForAnyEvent(["connect.challenge", "session.welcome"]);
      const challenge = initialHandshakeEvent?.nonce
        ? initialHandshakeEvent
        : await this.waitForEvent("connect.challenge");
      const params = this.buildConnectParams(profile, challenge);
      const connectResult = await this.sendRequest("connect", params);

      const returnedDeviceToken = connectResult?.auth?.deviceToken || connectResult?.deviceToken || null;
      if (returnedDeviceToken) {
        await this.identity.persistDeviceToken(returnedDeviceToken);
      }

      await this.auditLogger.write({
        kind: "gateway-connected",
        gatewayUrl: this.gatewayUrl,
        nodeId: this.identity.nodeId,
        protocol: connectResult?.protocol || PROTOCOL_VERSION
      });

      return connectResult;
    } catch (error) {
      if (this.socket === socket) {
        this.socket = null;
      }
      socket.close?.();
      throw error;
    }
  }

  resolveHandshakeProfiles() {
    if (this.handshakeProfile === HANDSHAKE_PROFILE_MODERN) {
      return [HANDSHAKE_PROFILE_MODERN];
    }

    if (this.handshakeProfile === HANDSHAKE_PROFILE_LEGACY) {
      return [HANDSHAKE_PROFILE_LEGACY];
    }

    return this.preferredHandshakeProfile === HANDSHAKE_PROFILE_LEGACY
      ? [HANDSHAKE_PROFILE_LEGACY]
      : [HANDSHAKE_PROFILE_MODERN, HANDSHAKE_PROFILE_LEGACY];
  }

  buildConnectParams(profile, challenge) {
    const client = buildClientMetadata(this.nodeInfo, profile);
    const gatewayToken = this.gatewayToken || this.identity.deviceToken || null;
    const signedDevice = this.identity.buildSignedDevice({
      nonce: challenge?.nonce || "",
      token: gatewayToken,
      clientId: client.id,
      clientMode: client.mode,
      role: "node",
      scopes: [],
      platform: this.nodeInfo.platform,
      deviceFamily: this.nodeInfo.deviceFamily,
      profile
    });

    if (profile === HANDSHAKE_PROFILE_MODERN) {
      return {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client,
        ...(this.nodeInfo.caps?.length ? { caps: this.nodeInfo.caps } : {}),
        ...(this.nodeInfo.commands?.length ? { commands: this.nodeInfo.commands } : {}),
        ...(this.nodeInfo.permissions && Object.keys(this.nodeInfo.permissions).length
          ? { permissions: this.nodeInfo.permissions }
          : {}),
        role: "node",
        scopes: [],
        ...(gatewayToken ? { auth: { token: gatewayToken } } : {}),
        device: signedDevice
      };
    }

    return {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client,
      auth: gatewayToken ? { token: gatewayToken } : {},
      device: signedDevice,
      role: "node",
      scopes: [],
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      userAgent: `${APP_ID}/${APP_VERSION}`
    };
  }

  waitForEvent(eventName) {
    if (this.seenEvents.has(eventName)) {
      return Promise.resolve(this.seenEvents.get(eventName));
    }

    const eventKey = `event:${eventName}`;
    let handler;

    return this.withTimeout(
      new Promise((resolve) => {
        handler = (params) => {
          this.off(eventKey, handler);
          resolve(params);
        };
        this.on(eventKey, handler);
      }),
      this.eventTimeoutMs,
      () => protocolError(`timed out waiting for event: ${eventName}`, "EVENT_TIMEOUT", { eventName }),
      () => {
        if (handler) {
          this.off(eventKey, handler);
        }
      }
    );
  }

  async waitForAnyEvent(eventNames) {
    for (const eventName of eventNames) {
      if (this.seenEvents.has(eventName)) {
        return this.seenEvents.get(eventName);
      }
    }

    let cleanups = [];

    return this.withTimeout(
      new Promise((resolve) => {
        cleanups = eventNames.map((eventName) => {
          const eventKey = `event:${eventName}`;
          const handler = (payload) => {
            for (const [cleanupEvent, cleanupHandler] of cleanups) {
              this.off(cleanupEvent, cleanupHandler);
            }
            resolve(payload);
          };
          this.on(eventKey, handler);
          return [eventKey, handler];
        });
      }),
      this.eventTimeoutMs,
      () => protocolError("timed out waiting for any event", "EVENT_TIMEOUT", { eventNames }),
      () => {
        for (const [cleanupEvent, cleanupHandler] of cleanups) {
          this.off(cleanupEvent, cleanupHandler);
        }
      }
    );
  }

  async handleFrame(frame) {
    const type = frameType(frame);
    if (!type) {
      throw protocolError("missing frame type");
    }

    if (type === "res") {
      const pending = this.pending.get(frame.id);
      if (!pending) {
        return;
      }

      this.pending.delete(frame.id);
      if (frame.ok === false) {
        pending.reject(protocolError(frame.error?.message || "request failed", frame.error?.code, frame.error));
      } else {
        pending.resolve(framePayload(frame));
      }
      return;
    }

    if (type === "event") {
      const eventName = frameEvent(frame);
      const payload = framePayload(frame);
      this.seenEvents.set(eventName, payload);
      this.emit(`event:${eventName}`, payload);
      this.emit("event", frame);
      return;
    }

    if (type === "req") {
      this.emit(`request:${frame.method}`, frame);
      this.emit("request", frame);
      return;
    }

    throw protocolError(`unsupported frame type: ${type}`);
  }

  async sendRequest(method, params) {
    if (!this.socket || this.socket.readyState !== 1) {
      throw protocolError("websocket is not connected", "NOT_CONNECTED");
    }

    const id = crypto.randomUUID();
    const frame = {
      type: "req",
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(protocolError(`request timed out: ${method}`, "REQUEST_TIMEOUT", { method, id }));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
      this.socket.send(JSON.stringify(frame));
    });
  }

  withTimeout(promise, timeoutMs, createError, cleanup = () => {}) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(createError());
      }, timeoutMs);

      promise.then(
        (value) => {
          clearTimeout(timeout);
          cleanup();
          resolve(value);
        },
        (error) => {
          clearTimeout(timeout);
          cleanup();
          reject(error);
        }
      );
    });
  }

  sendResponse(id, result) {
    return this.sendFrame({
      type: "res",
      t: "res",
      id,
      ok: true,
      payload: result,
      result
    });
  }

  sendError(id, error) {
    return this.sendFrame({
      type: "res",
      t: "res",
      id,
      ok: false,
      error: {
        code: error.code || "INTERNAL_ERROR",
        message: error.message || "internal error",
        data: error.details
      }
    });
  }

  sendFrame(frame) {
    if (!this.socket || this.socket.readyState !== 1) {
      return false;
    }

    this.socket.send(JSON.stringify(frame));
    return true;
  }

  async sendNodeInvokeResult({ id, nodeId, result, error }) {
    const params = {
      id,
      nodeId
    };

    if (result !== undefined) {
      params.resultJSON = JSON.stringify(result);
    }

    if (error) {
      params.error = {
        code: error.code || "INTERNAL_ERROR",
        message: error.message || "internal error",
        data: error.details
      };
    }

    await this.sendRequest("node.invoke.result", params);
  }

  close() {
    const socket = this.socket;
    this.socket = null;

    if (socket && typeof socket.close === "function") {
      socket.close();
      return true;
    }

    return false;
  }
}
