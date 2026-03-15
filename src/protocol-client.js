import crypto from "node:crypto";
import { EventEmitter } from "node:events";

import { APP_ID, APP_VERSION, PROTOCOL_VERSION } from "./constants.js";
import { parseJsonText } from "./fs-util.js";

function protocolError(message, code = "PROTOCOL_ERROR", details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function buildClientMetadata(nodeInfo) {
  return {
    id: APP_ID,
    displayName: nodeInfo.displayName,
    version: APP_VERSION,
    platform: nodeInfo.platform,
    mode: "node",
    instanceId: crypto.randomUUID()
  };
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
    this.identity = identity;
    this.nodeInfo = nodeInfo;
    this.auditLogger = auditLogger;
    this.socket = null;
    this.pending = new Map();
    this.seenEvents = new Map();
  }

  async connect() {
    const socket = new WebSocket(this.gatewayUrl);
    this.socket = socket;
    let onOpen;
    let onError;

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
        this.emit("error", error);
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
      this.emit("error", protocolError("websocket error", "WEBSOCKET_ERROR", event));
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

    const challenge = await this.waitForAnyEvent(["connect.challenge", "session.welcome"]);
    const client = buildClientMetadata(this.nodeInfo);
    const gatewayToken = this.identity.deviceToken || this.gatewayToken || null;
    const connectResult = await this.sendRequest("connect", {
      protocolVersion: PROTOCOL_VERSION,
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client,
      auth: gatewayToken ? { token: gatewayToken } : {},
      device: {
        ...this.identity.buildSignedDevice({
          nonce: challenge?.nonce || "",
          token: gatewayToken,
          clientId: client.id,
          clientMode: client.mode,
          role: "node",
          scopes: []
        }),
        displayName: this.nodeInfo.displayName,
        platform: this.nodeInfo.platform,
        deviceFamily: this.nodeInfo.deviceFamily
      },
      role: {
        type: "node",
        nodeId: this.identity.nodeId,
        displayName: this.nodeInfo.displayName,
        commands: this.nodeInfo.commands,
        caps: this.nodeInfo.caps,
        permissions: this.nodeInfo.permissions,
        browserToolsEnabled: this.nodeInfo.browserToolsEnabled ?? false,
        browserProxyEnabled: this.nodeInfo.browserProxyEnabled ?? false
      },
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      userAgent: `${APP_ID}/${APP_VERSION}`
    });

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
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw protocolError("websocket is not connected", "NOT_CONNECTED");
    }

    const id = crypto.randomUUID();
    const frame = {
      type: "req",
      t: "req",
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
    this.socket.send(
      JSON.stringify({
        type: "res",
        t: "res",
        id,
        ok: true,
        payload: result,
        result
      })
    );
  }

  sendError(id, error) {
    this.socket.send(
      JSON.stringify({
        type: "res",
        t: "res",
        id,
        ok: false,
        error: {
          code: error.code || "INTERNAL_ERROR",
          message: error.message || "internal error",
          data: error.details
        }
      })
    );
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
}
