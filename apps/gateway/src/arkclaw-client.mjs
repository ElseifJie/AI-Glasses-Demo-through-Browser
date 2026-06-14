import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import WebSocket from "ws";
import nacl from "tweetnacl";

const NEEDS_INPUT_PATTERNS = [
  /需要/,
  /请提供/,
  /请确认/,
  /请选择/,
  /请先/,
  /请绑定/,
  /请设置/,
  /请配置/,
  /缺少/,
  /未找到/,
  /无法/,
  /不能/,
  /没有权限/,
];
const PROTOCOL_VERSION = 3;
const ROLE = "operator";
const SCOPES = ["operator.read", "operator.write"];
const DEFAULT_DEVICE_FILE = path.resolve(process.cwd(), ".arkclaw-device.json");

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function normalizeAsciiLower(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed.replace(/[A-Z]/g, (char) => char.toLowerCase()) : "";
}

function loadOrCreateIdentity(filePath) {
  if (fs.existsSync(filePath)) {
    const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (saved?.version === 1 && saved?.seed && saved?.deviceId) {
      const seed = new Uint8Array(base64UrlDecode(saved.seed));
      const pair = nacl.sign.keyPair.fromSeed(seed);
      return {
        deviceId: saved.deviceId,
        filePath,
        publicKey: pair.publicKey,
        secretKey: pair.secretKey,
        seed,
        tokens: saved.tokens || {},
      };
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const seed = new Uint8Array(crypto.randomBytes(32));
  const pair = nacl.sign.keyPair.fromSeed(seed);
  const deviceId = crypto
    .createHash("sha256")
    .update(Buffer.from(pair.publicKey))
    .digest("hex");
  const stored = {
    version: 1,
    deviceId,
    seed: base64UrlEncode(seed),
    publicKey: base64UrlEncode(pair.publicKey),
    secretKey: base64UrlEncode(pair.secretKey),
    tokens: {},
  };
  fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`);
  return {
    deviceId,
    filePath,
    publicKey: pair.publicKey,
    secretKey: pair.secretKey,
    seed,
    tokens: {},
  };
}

function persistIdentity(identity) {
  const stored = {
    version: 1,
    deviceId: identity.deviceId,
    seed: base64UrlEncode(identity.seed),
    publicKey: base64UrlEncode(identity.publicKey),
    secretKey: base64UrlEncode(identity.secretKey),
    tokens: identity.tokens || {},
  };
  fs.writeFileSync(identity.filePath, `${JSON.stringify(stored, null, 2)}\n`);
}

function buildDeviceAuthPayloadV3(params) {
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
    normalizeAsciiLower(params.platform),
    normalizeAsciiLower(params.deviceFamily),
  ].join("|");
}

function signDevicePayload(secretKey, payload) {
  return base64UrlEncode(
    nacl.sign.detached(Buffer.from(payload, "utf8"), secretKey)
  );
}

export class ArkClawClient {
  constructor(env) {
    this.config = {
      gatewayUrl: env.GATEWAY_URL || "",
      gatewayInstance: env.GATEWAY_INSTANCE || "",
      gatewayApiKey: env.GATEWAY_APIKEY || "",
      gatewayToken: env.GATEWAY_TOKEN || "",
      displayName: env.GATEWAY_DISPLAY_NAME || "ai-glasses-gateway",
      clientId: env.GATEWAY_CLIENT_ID || "gateway-client",
      clientMode: env.GATEWAY_CLIENT_MODE || "backend",
      locale: env.GATEWAY_LOCALE || "zh-CN",
      sessionKey: env.SESSION_KEY || "main",
      deviceFile: env.DEVICE_FILE || DEFAULT_DEVICE_FILE,
      platform: normalizeAsciiLower(process.platform),
      deviceFamily: normalizeAsciiLower(process.arch),
    };
    this.identity = loadOrCreateIdentity(this.config.deviceFile);
    this.ws = null;
    this.pending = new Map();
    this.challengeNonce = null;
    this.challengeResolvers = [];
    this.chatRuns = new Map();
    this._lock = null;
  }

  isConfigured() {
    return Boolean(
      this.config.gatewayUrl &&
        this.config.gatewayInstance &&
        this.config.gatewayApiKey &&
        this.config.gatewayToken
    );
  }

  async sendTextCommand(text) {
    if (!this.isConfigured()) {
      throw new Error("ArkClaw gateway credentials are not fully configured.");
    }

    const callId = crypto.randomUUID().slice(0, 8);
    console.log(`[arkclaw:${callId}] sendTextCommand ENTER, text="${text.slice(0, 40)}", lock=${this._lock ? "BUSY" : "free"}`);

    if (this._lock) {
      console.log(`[arkclaw:${callId}] aborting stale lock from previous call, disconnecting`);
      this._disconnect();
    }

    const lock = {};
    this._lock = lock;
    console.log(`[arkclaw:${callId}] lock acquired`);

    try {
      console.log(`[arkclaw:${callId}] calling _resetState`);
      this._resetState();
      console.log(`[arkclaw:${callId}] calling _open`);
      await this._open();
      console.log(`[arkclaw:${callId}] _open done, calling _connectOrPair`);
      const authResult = await this._connectOrPair();
      console.log(`[arkclaw:${callId}] authResult=${authResult.status}`);

      if (authResult.status === "pairing-required") {
        return {
          status: "pairing-required",
          requestId: authResult.requestId,
          clientId: authResult.clientId,
          deviceId: authResult.deviceId,
          detail: `设备需要先配对。\nclientId: ${authResult.clientId}\ndeviceId: ${authResult.deviceId}\nrequestId: ${authResult.requestId}\n请到 ArkClaw 后端执行脚本审批对接申请。`,
        };
      }

      const runId = crypto.randomUUID();
      const finalResult = this._waitForChatRun(runId);
      const fullMessage = `请以用户身份（default 模式）执行以下操作，所有创建的文档、日程均以用户的身份创建：\n${text}`;
      console.log(`[arkclaw:${callId}] sending chat.send, runId=${runId}, text="${text}"`);
      await this._request("chat.send", {
        sessionKey: this.config.sessionKey,
        message: fullMessage,
        idempotencyKey: runId,
      });
      console.log(`[arkclaw:${callId}] chat.send sent, awaiting response`);
      const payload = await finalResult;
      console.log(`[arkclaw:${callId}] chat.send response received`);
      const detail = payload?.message?.content?.[0]?.text || "ArkClaw 已完成任务。";
      const isNeedsInput = NEEDS_INPUT_PATTERNS.some((p) => p.test(detail));
      console.log(`[arkclaw:${callId}] returning status=${isNeedsInput ? "needs-input" : "completed"}`);
      return {
        status: isNeedsInput ? "needs-input" : "completed",
        detail,
      };
    } catch (error) {
      console.log(`[arkclaw:${callId}] catch error="${error.message}", lock_matches=${this._lock === lock}`);
      if (error.message === "CANCELLED" || this._lock !== lock) {
        console.log(`[arkclaw:${callId}] cancelled, returning silently`);
        return { status: "cancelled", detail: "任务已被新指令替换" };
      }
      throw error;
    } finally {
      console.log(`[arkclaw:${callId}] finally, lock_matches=${this._lock === lock}`);
      if (this._lock === lock) {
        this._disconnect();
        this._lock = null;
        console.log(`[arkclaw:${callId}] disconnected and lock released`);
      } else {
        console.log(`[arkclaw:${callId}] skipping disconnect (not lock owner)`);
      }
    }
  }

  _disconnect() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) { /* ignore */ }
      this.ws = null;
    }
  }

  _resetState() {
    let rejected = 0;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(new Error("CANCELLED"));
      rejected++;
    }
    this.pending.clear();
    for (const entry of this.chatRuns.values()) {
      clearTimeout(entry.timeout);
      entry.reject(new Error("CANCELLED"));
      rejected++;
    }
    this.chatRuns.clear();
    const challengeEntries = this.challengeResolvers.splice(0);
    for (const entry of challengeEntries) {
      entry.reject(new Error("CANCELLED"));
      rejected++;
    }
    this.challengeNonce = null;
    if (rejected > 0) {
      console.log(`[arkclaw] _resetState: rejected ${rejected} stale promises`);
    }
  }

  async _open() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    this._disconnect();

    await new Promise((resolve, reject) => {
      const headers = {
        Authorization: `Bearer ${this.config.gatewayApiKey}`,
        "x-faas-instance-name": this.config.gatewayInstance,
      };
      const ws = new WebSocket(this.config.gatewayUrl, {
        headers,
        handshakeTimeout: 15000,
      });

      ws.on("open", () => {
        this.ws = ws;
        ws.on("message", (data) => this._handleFrame(JSON.parse(data.toString())));
        ws.on("close", () => {
          if (this.ws === ws) {
            this.ws = null;
          }
        });
        ws.on("error", () => {
          if (this.ws === ws) {
            this.ws = null;
          }
        });
        resolve();
      });

      ws.on("error", reject);
    });
  }

  async _connectOrPair() {
    const nonce = await this._waitForChallenge();
    const signedAtMs = Date.now();
    const storedDeviceToken = this.identity.tokens?.[ROLE]?.token;
    const payload = buildDeviceAuthPayloadV3({
      deviceId: this.identity.deviceId,
      clientId: this.config.clientId,
      clientMode: this.config.clientMode,
      role: ROLE,
      scopes: SCOPES,
      signedAtMs,
      token: this.config.gatewayToken,
      nonce,
      platform: this.config.platform,
      deviceFamily: this.config.deviceFamily,
    });
    const signature = signDevicePayload(this.identity.secretKey, payload);

    try {
      const hello = await this._request("connect", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: this.config.clientId,
          displayName: this.config.displayName,
          version: "0.1.0",
          platform: this.config.platform,
          deviceFamily: this.config.deviceFamily,
          mode: this.config.clientMode,
        },
        role: ROLE,
        scopes: SCOPES,
        caps: [],
        commands: [],
        permissions: {},
        locale: this.config.locale,
        userAgent: `${this.config.clientId}/0.1.0`,
        auth: storedDeviceToken
          ? { token: this.config.gatewayToken, deviceToken: storedDeviceToken }
          : { token: this.config.gatewayToken },
        device: {
          id: this.identity.deviceId,
          publicKey: base64UrlEncode(this.identity.publicKey),
          signature,
          signedAt: signedAtMs,
          nonce,
        },
      });

      const issuedDeviceToken = hello?.auth?.deviceToken;
      if (issuedDeviceToken) {
        this.identity.tokens = {
          ...(this.identity.tokens || {}),
          [ROLE]: {
            token: issuedDeviceToken.trim(),
            role: ROLE,
            scopes: SCOPES,
            updatedAtMs: Date.now(),
          },
        };
        persistIdentity(this.identity);
      }
      return { status: "connected" };
    } catch (error) {
      if (error?.details?.code === "PAIRING_REQUIRED") {
        return {
          status: "pairing-required",
          requestId: error.details.requestId || "",
          clientId: this.config.clientId,
          deviceId: this.identity.deviceId,
        };
      }
      throw error;
    }
  }

  _handleFrame(frame) {
    if (frame.type === "event" && frame.event === "connect.challenge") {
      const nonce = frame.payload?.nonce || "";
      if (this.challengeResolvers.length) {
        this.challengeResolvers.shift().resolve(nonce);
      } else {
        this.challengeNonce = nonce;
      }
      return;
    }

    if (frame.type === "res") {
      const entry = this.pending.get(frame.id);
      if (!entry) {
        return;
      }
      this.pending.delete(frame.id);
      clearTimeout(entry.timeout);
      if (frame.ok) {
        entry.resolve(frame.payload);
      } else {
        const error = new Error(frame.error?.message || "gateway request failed");
        error.details = frame.error?.details;
        entry.reject(error);
      }
      return;
    }

    if (frame.type === "event" && frame.event === "chat") {
      const payload = frame.payload || {};
      const entry = this.chatRuns.get(payload.runId);
      if (!entry) {
        return;
      }
      if (payload.state === "final") {
        this.chatRuns.delete(payload.runId);
        entry.resolve(payload);
      } else if (payload.state === "error") {
        this.chatRuns.delete(payload.runId);
        entry.reject(new Error(payload.errorMessage || "ArkClaw chat failed"));
      }
    }
  }

  _waitForChallenge() {
    if (typeof this.challengeNonce === "string") {
      const nonce = this.challengeNonce;
      this.challengeNonce = null;
      return Promise.resolve(nonce);
    }
    return new Promise((resolve, reject) => {
      this.challengeResolvers.push({ resolve, reject });
    });
  }

  _request(method, params = {}, timeoutMs = 20000) {
    if (!this.ws) {
      throw new Error("ArkClaw websocket is not open.");
    }
    const id = crypto.randomUUID();
    const msgSample = params.message ? params.message.slice(0, 60) : method;
    console.log(`[arkclaw] _request: ws.send type=req id=${id.slice(0,8)} method=${method} msg="${msgSample}"`);
    this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
  }

  _waitForChatRun(runId, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.chatRuns.delete(runId);
        reject(new Error(`timeout waiting for chat run ${runId}`));
      }, timeoutMs);
      this.chatRuns.set(runId, {
        resolve: (payload) => {
          clearTimeout(timeout);
          resolve(payload);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }
}
