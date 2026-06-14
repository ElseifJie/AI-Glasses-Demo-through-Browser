import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { WebSocket } from "ws";

const HEADER_BYTE_0 = 0x11;
const MESSAGE_TYPE = {
  FULL_CLIENT_REQUEST: 0x1,
  AUDIO_ONLY_REQUEST: 0x2,
  FULL_SERVER_RESPONSE: 0x9,
  ERROR: 0xf
};
const MESSAGE_FLAG = {
  NONE: 0x0,
  POSITIVE_SEQUENCE: 0x1,
  FINAL_PACKET: 0x2,
  NEGATIVE_SEQUENCE: 0x3
};
const SERIALIZATION = {
  NONE: 0x0,
  JSON: 0x1
};
const COMPRESSION = {
  NONE: 0x0,
  GZIP: 0x1
};

function createHeader(messageType, flags, serialization, compression) {
  return Buffer.from([
    HEADER_BYTE_0,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00
  ]);
}

function createLengthPrefix(size) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(size, 0);
  return buffer;
}

const GZIP_MAGIC = 0x1f8b;

function decodePayload(buffer, serialization, compression) {
  let payload = buffer;
  if (compression === COMPRESSION.GZIP && payload.length) {
    payload = gunzipSync(payload);
  }

  if (serialization === SERIALIZATION.JSON && payload.length) {
    let text = payload.toString("utf8");
    text = text.replace(/^[\x00-\x08\x0B\x0C\x0E-\x1F]+/, "");
    try {
      return JSON.parse(text);
    } catch {
      if (payload.length >= 2 && payload.readUInt16BE(0) === GZIP_MAGIC) {
        payload = gunzipSync(payload);
        return JSON.parse(payload.toString("utf8"));
      }
      throw new Error(`ASR JSON parse failed: ${text.slice(0, 200)}`);
    }
  }

  return payload;
}

function normalizeCodec(format) {
  return format === "ogg" ? "opus" : "raw";
}

function chunkPcm(buffer, chunkSize = 6400) {
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    chunks.push(buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length)));
  }
  return chunks;
}

export class VolcAsrClient {
  constructor(env = process.env) {
    this.url = env.VOLC_ASR_URL || "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
    this.appKey = env.VOLC_ASR_APP_KEY || "";
    this.accessKey = env.VOLC_ASR_ACCESS_KEY || "";
    this.resourceId = env.VOLC_ASR_RESOURCE_ID || "volc.bigasr.sauc.duration";
  }

  isConfigured() {
    return Boolean(this.appKey && this.accessKey && this.resourceId);
  }

  createSession(options = {}) {
    return new VolcAsrSession({
      url: this.url,
      appKey: this.appKey,
      accessKey: this.accessKey,
      resourceId: this.resourceId,
      ...options
    });
  }

  async transcribeBuffer({
    audioBuffer,
    format = "pcm",
    sampleRate = 16000,
    bits = 16,
    channel = 1
  }) {
    const utterances = [];
    let latestText = "";

    const session = this.createSession({
      format,
      sampleRate,
      bits,
      channel,
      onPartial: (text) => {
        latestText = text || latestText;
      },
      onUtterance: (text) => {
        if (text) {
          utterances.push(text);
        }
      }
    });

    await session.start();
    const chunks =
      format === "pcm" ? chunkPcm(audioBuffer, 6400) : chunkPcm(audioBuffer, 4096);

    for (const chunk of chunks) {
      session.writeAudio(chunk);
    }

    const result = await session.finishAndWait();
    const finalText = utterances.join("").trim() || latestText || result.latestText || "";

    return {
      text: finalText.trim(),
      utterances: result.utterances
    };
  }
}

export class VolcAsrSession {
  constructor({
    url,
    appKey,
    accessKey,
    resourceId,
    sessionId = randomUUID(),
    format = "pcm",
    sampleRate = 16000,
    bits = 16,
    channel = 1,
    onPartial = () => {},
    onUtterance = () => {},
    onError = () => {}
  }) {
    this.url = url;
    this.appKey = appKey;
    this.accessKey = accessKey;
    this.resourceId = resourceId;
    this.sessionId = sessionId;
    this.format = format;
    this.sampleRate = sampleRate;
    this.bits = bits;
    this.channel = channel;
    this.onPartial = onPartial;
    this.onUtterance = onUtterance;
    this.onError = onError;
    this.lastUtteranceEndTime = -1;
    this.latestText = "";
    this.utterances = [];
    this.ws = null;
    this.started = false;
    this.finished = false;
    this.pendingAudio = [];
  }

  async start() {
    if (this.started) {
      return;
    }

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        headers: {
          "X-Api-App-Key": this.appKey,
          "X-Api-Access-Key": this.accessKey,
          "X-Api-Resource-Id": this.resourceId,
          "X-Api-Connect-Id": this.sessionId,
          "X-Api-Request-Id": this.sessionId
        }
      });

      const fail = (error) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      ws.once("open", () => {
        this.ws = ws;
        this.started = true;
        ws.on("message", (message) => {
          try {
            this.handleMessage(message);
          } catch (error) {
            this.onError(error);
          }
        });
        ws.on("error", (error) => this.onError(error));
        const payload = {
          user: {
            uid: this.sessionId,
            did: "ai-glasses-demo",
            platform: "web-gateway",
            sdk_version: "0.1.0",
            app_version: "0.1.0"
          },
          audio: {
            format: this.format,
            codec: normalizeCodec(this.format),
            rate: this.sampleRate,
            bits: this.bits,
            channel: this.channel
          },
          request: {
            model_name: "bigmodel",
            enable_itn: true,
            enable_punc: true,
            enable_nonstream: false,
            show_utterances: true,
            result_type: "single",
            end_window_size: 800
          }
        };
        ws.send(this.buildJsonFrame(payload));
        for (const pending of this.pendingAudio) {
          ws.send(this.buildAudioFrame(pending, false));
        }
        this.pendingAudio = [];
        resolve();
      });

      ws.once("error", fail);
    });
  }

  buildJsonFrame(payload) {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    return Buffer.concat([
      createHeader(
        MESSAGE_TYPE.FULL_CLIENT_REQUEST,
        MESSAGE_FLAG.NONE,
        SERIALIZATION.JSON,
        COMPRESSION.NONE
      ),
      createLengthPrefix(body.length),
      body
    ]);
  }

  buildAudioFrame(audioBuffer, isFinal = false) {
    return Buffer.concat([
      createHeader(
        MESSAGE_TYPE.AUDIO_ONLY_REQUEST,
        isFinal ? MESSAGE_FLAG.FINAL_PACKET : MESSAGE_FLAG.NONE,
        SERIALIZATION.NONE,
        COMPRESSION.NONE
      ),
      createLengthPrefix(audioBuffer.length),
      audioBuffer
    ]);
  }

  writeAudio(audioBuffer) {
    if (this.finished) {
      return;
    }
    if (!this.ws) {
      this.pendingAudio.push(audioBuffer);
      return;
    }
    this.ws.send(this.buildAudioFrame(audioBuffer, false));
  }

  async finishAndWait(timeoutMs = 8000) {
    if (!this.ws || this.finished) {
      return {
        latestText: this.latestText,
        utterances: [...this.utterances]
      };
    }

    this.finished = true;
    this.ws.send(this.buildAudioFrame(Buffer.alloc(0), true));

    await new Promise((resolve) => {
      const done = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.ws?.off("close", done);
        this.ws?.off("error", done);
      };
      const timeout = setTimeout(() => {
        this.ws?.close();
        done();
      }, timeoutMs);

      this.ws?.once("close", done);
      this.ws?.once("error", done);
    });

    return {
      latestText: this.latestText,
      utterances: [...this.utterances]
    };
  }

  close() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      this.ws.close();
    }
    this.finished = true;
  }

  handleMessage(message) {
    const buffer = Buffer.isBuffer(message) ? message : Buffer.from(message);
    const header = buffer.subarray(0, 4);
    const messageType = header[1] >> 4;
    const flags = header[1] & 0x0f;
    const serialization = header[2] >> 4;
    const compression = header[2] & 0x0f;

    let offset = 4;
    let sequence = null;
    if (
      messageType === MESSAGE_TYPE.FULL_SERVER_RESPONSE &&
      (flags === MESSAGE_FLAG.POSITIVE_SEQUENCE || flags === MESSAGE_FLAG.NEGATIVE_SEQUENCE)
    ) {
      sequence = buffer.readInt32BE(offset);
      offset += 4;
    }

    const payloadSize = buffer.readUInt32BE(offset);
    offset += 4;
    const payloadBuffer = buffer.subarray(offset, offset + payloadSize);
    const payload = decodePayload(payloadBuffer, serialization, compression);

    if (messageType === MESSAGE_TYPE.ERROR) {
      const detail =
        typeof payload === "string" ? payload : payload?.message || "unknown ASR error";
      this.onError(new Error(detail));
      return;
    }

    if (messageType !== MESSAGE_TYPE.FULL_SERVER_RESPONSE || !payload?.result) {
      return;
    }

    const text = payload.result.text?.trim() || "";
    if (text) {
      this.latestText = text;
      this.onPartial(text);
    }

    const utterances = payload.result.utterances || [];
    for (const utterance of utterances) {
      if (!utterance?.definite) {
        continue;
      }
      if (typeof utterance.end_time === "number" && utterance.end_time <= this.lastUtteranceEndTime) {
        continue;
      }
      this.lastUtteranceEndTime = utterance.end_time ?? this.lastUtteranceEndTime;
      const finalText = utterance.text?.trim();
      if (finalText) {
        this.utterances.push(finalText);
        this.onUtterance(finalText);
      }
    }

    if (sequence !== null && sequence < 0) {
      this.close();
    }
  }
}
