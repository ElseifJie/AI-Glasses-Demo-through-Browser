import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { WebSocket } from "ws";

const EVENT_CODE = {
  SESSION_FINISHED: 152,
  TTS_SENTENCE_START: 350,
  TTS_SENTENCE_END: 351,
  TTS_RESPONSE: 352
};

const HEADER = {
  REQUEST_JSON: Buffer.from([0x11, 0x10, 0x10, 0x00])
};

function createLengthPrefix(size) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(size, 0);
  return buffer;
}

function decodeJson(buffer) {
  if (!buffer.length) {
    return null;
  }
  return JSON.parse(buffer.toString("utf8"));
}

function maybeGunzip(buffer, compressionFlag) {
  return compressionFlag === 0x1 && buffer.length ? gunzipSync(buffer) : buffer;
}

function extractEventFrame(buffer) {
  const messageType = buffer[1] >> 4;
  const flags = buffer[1] & 0x0f;
  const serialization = buffer[2] >> 4;
  const compression = buffer[2] & 0x0f;

  if (flags !== 0x4) {
    const payloadLength = buffer.readUInt32BE(4);
    const payload = maybeGunzip(buffer.subarray(8, 8 + payloadLength), compression);
    return {
      messageType,
      serialization,
      eventCode: null,
      sessionId: null,
      payload
    };
  }

  let offset = 4;
  const eventCode = buffer.readUInt32BE(offset);
  offset += 4;
  const sessionIdLength = buffer.readUInt32BE(offset);
  offset += 4;
  const sessionId = buffer.subarray(offset, offset + sessionIdLength).toString("utf8");
  offset += sessionIdLength;
  const payloadLength = buffer.readUInt32BE(offset);
  offset += 4;
  const payload = maybeGunzip(buffer.subarray(offset, offset + payloadLength), compression);

  return {
    messageType,
    serialization,
    eventCode,
    sessionId,
    payload
  };
}

export class VolcTtsClient {
  constructor(env = process.env) {
    this.url =
      env.VOLC_TTS_URL || "wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream";
    this.appId = env.VOLC_TTS_APP_ID || "";
    this.accessKey = env.VOLC_TTS_ACCESS_KEY || env.VOLC_TTS_ACCESS_TOKEN || "";
    this.resourceId = env.VOLC_TTS_RESOURCE_ID || "seed-tts-2.0";
    this.voiceType = env.VOLC_TTS_VOICE_TYPE || "zh_female_vv_uranus_bigtts";
    this._ws = null;
    this._queue = [];
    this._processing = false;
    this._openPromise = null;
  }

  isConfigured() {
    return Boolean(this.appId && this.accessKey && this.resourceId && this.voiceType);
  }

  async _getConnection() {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      return this._ws;
    }
    if (this._openPromise) {
      return this._openPromise;
    }

    this._openPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        headers: {
          "X-Api-App-Id": this.appId,
          "X-Api-Access-Key": this.accessKey,
          "X-Api-Resource-Id": this.resourceId,
          "X-Api-Request-Id": randomUUID()
        },
        handshakeTimeout: 10000
      });

      ws.once("open", () => {
        this._ws = ws;
        this._openPromise = null;
        ws.on("close", () => {
          if (this._ws === ws) {
            this._ws = null;
            this._openPromise = null;
          }
        });
        ws.on("error", () => {
          if (this._ws === ws) {
            this._ws = null;
            this._openPromise = null;
          }
        });
        resolve(ws);
      });

      ws.once("error", (err) => {
        this._openPromise = null;
        reject(err);
      });
    });

    return this._openPromise;
  }

  async synthesize(text, options = {}) {
    if (!text?.trim()) {
      return null;
    }

    const sessionId = options.sessionId || randomUUID();
    const format = options.format || "mp3";
    const sampleRate = options.sampleRate || 24000;
    const speechRate = options.speechRate ?? 1;
    const timeoutMs = options.timeoutMs || 3000;

    const body = {
      user: { uid: sessionId },
      req_params: {
        text,
        speaker: this.voiceType,
        audio_params: {
          format,
          sample_rate: sampleRate,
          speech_rate: speechRate
        }
      }
    };

    return new Promise((resolve, reject) => {
      const task = { body, sessionId, format, timeoutMs, resolve, reject };
      this._queue.push(task);
      if (!this._processing) {
        this._processQueue();
      }
    });
  }

  async _processQueue() {
    if (this._processing || !this._queue.length) {
      return;
    }

    this._processing = true;

    while (this._queue.length) {
      const task = this._queue.shift();
      try {
        const ws = await this._getConnection();
        task.resolve(await this._synthesizeOnConnection(ws, task));
      } catch (error) {
        task.reject(error);
      }
    }

    this._processing = false;
  }

  _synthesizeOnConnection(ws, task) {
    const { body, format, timeoutMs } = task;

    return new Promise((resolve, reject) => {
      const audioChunks = [];
      let settled = false;

      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const timeout = setTimeout(() => {
        fail(new Error("TTS synthesis timed out"));
      }, timeoutMs);

      const handler = (message) => {
        try {
          const buffer = Buffer.isBuffer(message) ? message : Buffer.from(message);
          const frame = extractEventFrame(buffer);

          if (frame.eventCode === EVENT_CODE.TTS_RESPONSE) {
            audioChunks.push(frame.payload);
            return;
          }

          if (frame.eventCode === EVENT_CODE.SESSION_FINISHED) {
            ws.off("message", handler);
            const audioBuffer = Buffer.concat(audioChunks);
            done({
              audioBuffer,
              audioBase64: audioBuffer.toString("base64"),
              mimeType: format === "pcm" ? "audio/pcm" : `audio/${format}`
            });
            return;
          }

          if (frame.messageType === 0xf) {
            ws.off("message", handler);
            let detail = "unknown TTS error";
            if (frame.serialization === 0x1 && frame.payload?.length) {
              try {
                detail = decodeJson(frame.payload)?.message || detail;
              } catch {
                detail = frame.payload.toString("utf8").slice(0, 200);
              }
            } else if (frame.payload?.length) {
              detail = frame.payload.toString("utf8").slice(0, 200);
            }
            fail(new Error(detail));
          }
        } catch (error) {
          ws.off("message", handler);
          fail(error);
        }
      };

      ws.on("message", handler);

      const payload = Buffer.from(JSON.stringify(body), "utf8");
      ws.send(Buffer.concat([HEADER.REQUEST_JSON, createLengthPrefix(payload.length), payload]));
    });
  }

  close() {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._queue = [];
    this._processing = false;
  }
}
