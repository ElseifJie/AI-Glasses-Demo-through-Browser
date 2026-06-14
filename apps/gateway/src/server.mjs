import "dotenv/config";
import { randomUUID } from "node:crypto";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import {
  ClientEvent,
  ServerEvent,
  SessionState,
  Intent,
  createSessionState,
  detectIntent
} from "@ai-glasses/shared";
import { ArkClawClient } from "./arkclaw-client.mjs";
import { VolcAsrClient } from "./volc-asr-client.mjs";
import { VolcTtsClient } from "./volc-tts-client.mjs";

const port = Number(process.env.PORT || 8787);
const veadkAgentUrl = process.env.VEADK_AGENT_URL || "http://127.0.0.1:9001";
const arkclawClient = new ArkClawClient(process.env);
const volcAsrClient = new VolcAsrClient(process.env);
const volcTtsClient = new VolcTtsClient(process.env);

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "gateway" });
});

const server = app.listen(port, () => {
  console.log(`[gateway] listening on http://127.0.0.1:${port}`);
  if (volcTtsClient.isConfigured()) {
    synthesizeSpeech("。").catch((err) =>
      console.warn("[gateway] TTS pre-warm failed:", err.message)
    );
  }
});

const wss = new WebSocketServer({ server });
const sessions = new Map();

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  } else {
    console.warn("[gateway] dropping message: ws not OPEN, readyState=%d, type=%s",
      ws.readyState, payload.type);
  }
}

async function synthesizeSpeech(text, options = {}) {
  if (!volcTtsClient.isConfigured() || !text?.trim()) {
    return null;
  }

  try {
    return await volcTtsClient.synthesize(text, {
      format: "mp3",
      sampleRate: 24000,
      ...options
    });
  } catch (error) {
    console.error("[tts] synthesis failed:", error);
    return null;
  }
}

async function* callVeadkStream(payload) {
  const response = await fetch(`${veadkAgentUrl}/chat/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`veadk-agent stream returned ${response.status}: ${body.slice(0, 200)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data);
        } catch {
          console.warn("[gateway] failed to parse SSE data:", data.slice(0, 80));
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function streamVeadkToClient(ws, payload, { t0, t1 = t0, intent, withTiming = true }) {
  const turnTtsSessionId = randomUUID();
  let tFirstSentenceAgent = null;
  let tFirstSentenceTts = null;
  let allDisplayText = "";
  let allSpeechText = "";
  let sentenceCount = 0;

  for await (const sentence of callVeadkStream(payload)) {
    if (sentence.final) {
      allDisplayText = sentence.displayText || allDisplayText;
      continue;
    }
    if (!sentence.speechText && !sentence.displayText) continue;

    sentenceCount++;
    if (sentenceCount === 1) {
      tFirstSentenceAgent = Date.now();
    }

    allDisplayText += sentence.displayText;
    allSpeechText += sentence.speechText;

    const tts = await synthesizeSpeech(sentence.speechText, { sessionId: turnTtsSessionId });

    if (sentenceCount === 1) {
      tFirstSentenceTts = Date.now();
    }

    send(ws, {
      type: ServerEvent.ASSISTANT_RESULT,
      sessionId: payload.sessionId,
      route: "veadk",
      speechText: sentence.speechText,
      displayText: sentence.displayText,
      audioBase64: tts?.audioBase64 || null,
      audioMimeType: tts?.mimeType || null,
      meta: { intent, phase: "sentence" },
      timing: withTiming && sentenceCount === 1
        ? {
            asrMs: t1 - t0,
            agentMs: tFirstSentenceAgent - t1,
            ttsMs: tFirstSentenceTts - tFirstSentenceAgent,
            totalMs: tFirstSentenceTts - t0,
            ttfrMs: tFirstSentenceTts - t0
          }
        : null
    });
  }

  const t3 = Date.now();
  const t2 = tFirstSentenceAgent || t1;

  return {
    allDisplayText,
    allSpeechText,
    timing: {
      asrMs: withTiming ? t1 - t0 : 0,
      agentMs: withTiming ? t2 - t1 : t2 - t0,
      ttsMs: t3 - t2,
      totalMs: t3 - t0,
      ttfrMs: withTiming ? (tFirstSentenceTts ? tFirstSentenceTts - t0 : t3 - t0) : null
    }
  };
}

async function delegateToArkClaw(payload, ws) {
  const title = "ArkClaw 飞书任务";
  console.log(`[gateway] delegateToArkClaw called, text="${(payload.text || "").slice(0, 60)}", sessionId=${payload.sessionId}`);

  send(ws, {
    type: ServerEvent.ASSISTANT_TASK,
    sessionId: payload.sessionId,
    status: "running",
    title,
    detail: "正在将飞书指令发送给 ArkClaw"
  });

  const tArkStart = Date.now();

  try {
    const result = await arkclawClient.sendTextCommand(payload.text);
    const tArkDone = Date.now();
    console.log(`[gateway] delegateToArkClaw result.status=${result.status}, arkMs=${tArkDone - tArkStart}`);

    if (result.status === "cancelled") {
      console.log("[gateway] arkclaw task cancelled, not forwarding to frontend");
      return { speechText: "", displayText: "", arkMs: 0, tArkDone };
    }

    const taskStatus = result.status === "completed" ? "completed" : "blocked";
    let detail = result.detail;
    if (result.status === "pairing-required") {
      detail = `设备需要先配对。\nclientId: ${result.clientId}\ndeviceId: ${result.deviceId}\nrequestId: ${result.requestId}\n请到 ArkClaw 后端执行脚本审批对接申请。`;
    }
    send(ws, {
      type: ServerEvent.ASSISTANT_TASK,
      sessionId: payload.sessionId,
      status: taskStatus,
      title,
      detail
    });

    if (result.status === "needs-input") {
      const isAuth = /授权|权限|绑定|登录|认证|确认身份|strict.?mode/.test(result.detail);
      const prefix = isAuth ? "需要授权：" : "需要你确认：";
      return {
        speechText: prefix + result.detail.slice(0, 80),
        displayText: detail,
        arkMs: tArkDone - tArkStart,
        tArkDone
      };
    }
    return {
      speechText:
        result.status === "completed" ? "飞书任务已经处理完成。" : "ArkClaw 设备还需要配对。",
      displayText: detail,
      arkMs: tArkDone - tArkStart,
      tArkDone
    };
  } catch (error) {
    send(ws, {
      type: ServerEvent.ASSISTANT_TASK,
      sessionId: payload.sessionId,
      status: "failed",
      title,
      detail: error.message
    });
    return {
      speechText: "ArkClaw 任务执行失败。",
      displayText: error.message,
      arkMs: 0,
      tArkDone: Date.now()
    };
  }
}

async function handleUserTranscript(ws, payload) {
  const t0 = payload.asrAudioEndAt || Date.now();
  const t1 = payload.receivedAt || Date.now();
  send(
    ws,
    createSessionState(SessionState.THINKING, "Processing user request.", payload.sessionId)
  );

  const intent = detectIntent(payload.text);

  if (intent === Intent.TAKE_PHOTO) {
    const session = sessions.get(payload.sessionId);
    if (session) {
      session.pendingPhotoText = payload.text;
    }
    send(ws, {
      type: ServerEvent.CAPTURE_PHOTO_REQUEST,
      sessionId: payload.sessionId,
      text: payload.text
    });
    return;
  }

  if (intent === Intent.SEND_FEISHU_MESSAGE) {
    console.log(`[gateway] handleUserTranscript: SEND_FEISHU_MESSAGE, text="${payload.text.slice(0, 60)}"`);
    send(
      ws,
      createSessionState(
        SessionState.DELEGATING,
        "This task is being delegated to ArkClaw.",
        payload.sessionId
      )
    );

    delegateToArkClaw({ ...payload, intent }, ws)
      .then(async (result) => {
        const session = sessions.get(payload.sessionId);
        if (!session || session.closed || ws.readyState !== WebSocket.OPEN) {
          console.log("[gateway] arkclaw result dropped: session closed or ws gone");
          return;
        }

        if (!result.speechText && !result.displayText) {
          console.log("[gateway] arkclaw cancelled task, not sending result");
          if (ws.readyState === WebSocket.OPEN) {
            send(
              ws,
              createSessionState(SessionState.LISTENING, "Waiting for the next utterance.", payload.sessionId)
            );
          }
          return;
        }
        console.log("[gateway] arkclaw resolved, speechText preview:",
          (result.speechText || "").slice(0, 60));
        const tTtsStart = Date.now();
        const tts = await synthesizeSpeech(result.speechText);
        const tNow = Date.now();
        console.log("[gateway] arkclaw tts done, hasAudio=%s, ws.readyState=%d",
          Boolean(tts?.audioBase64), ws.readyState);
        send(ws, {
          type: ServerEvent.ASSISTANT_RESULT,
          sessionId: payload.sessionId,
          route: "arkclaw",
          speechText: result.speechText,
          displayText: result.displayText,
          audioBase64: tts?.audioBase64 || null,
          audioMimeType: tts?.mimeType || null,
          meta: { intent, phase: "result" },
          timing: {
            asrMs: t1 - t0,
            agentMs: result.arkMs || 0,
            ttsMs: tNow - tTtsStart,
            totalMs: tNow - t0,
            ttfrMs: tNow - t0
          }
        });
        console.log("[gateway] arkclaw ASSISTANT_RESULT sent");
        send(
          ws,
          createSessionState(SessionState.SPEAKING, "ArkClaw result ready.", payload.sessionId)
        );
        send(
          ws,
          createSessionState(SessionState.LISTENING, "Waiting for the next utterance.", payload.sessionId)
        );
      })
      .catch((error) => {
        console.error("[gateway] arkclaw rejected:", error.message);
        send(ws, {
          type: ServerEvent.ASSISTANT_RESULT,
          sessionId: payload.sessionId,
          route: "arkclaw",
          speechText: "飞书任务执行失败。",
          displayText: error.message,
          audioBase64: null,
          audioMimeType: null,
          meta: { intent, phase: "error" },
          timing: {
            asrMs: t1 - t0,
            agentMs: 0,
            ttsMs: 0,
            totalMs: Date.now() - t0
          }
        });
        send(
          ws,
          createSessionState(SessionState.SPEAKING, "ArkClaw result ready.", payload.sessionId)
        );
        send(
          ws,
          createSessionState(SessionState.LISTENING, "Waiting for the next utterance.", payload.sessionId)
        );
      });

    const comfortText = "收到，正在通过飞书帮你处理，完成后告诉你。";
    const comfortTts = await synthesizeSpeech(comfortText);
    const tAck = Date.now();

    send(ws, {
      type: ServerEvent.ASSISTANT_RESULT,
      sessionId: payload.sessionId,
      route: "arkclaw",
      speechText: comfortText,
      displayText: comfortText,
      audioBase64: comfortTts?.audioBase64 || null,
      audioMimeType: comfortTts?.mimeType || null,
      meta: { intent, phase: "ack" },
      timing: {
        asrMs: t1 - t0,
        agentMs: 0,
        ttsMs: tAck - t1,
        totalMs: tAck - t0,
        ttfrMs: tAck - t0
      }
    });

    send(
      ws,
      createSessionState(SessionState.SPEAKING, "Acknowledged. Delegating to ArkClaw.", payload.sessionId)
    );
    send(
      ws,
      createSessionState(SessionState.LISTENING, "Waiting for the next utterance.", payload.sessionId)
    );

    return;
  }

  try {
    const result = await streamVeadkToClient(ws, {
      sessionId: payload.sessionId,
      userId: payload.userId || "",
      text: payload.text,
      intent
    }, { t0, t1, intent });

    send(ws, {
      type: ServerEvent.ASSISTANT_RESULT,
      sessionId: payload.sessionId,
      route: "veadk",
      speechText: result.allSpeechText,
      displayText: result.allDisplayText,
      audioBase64: null,
      audioMimeType: null,
      meta: { intent, phase: "final" },
      timing: result.timing
    });
  } catch (error) {
    console.error("[gateway] veadk stream error:", error.message);
    send(ws, {
      type: ServerEvent.ASSISTANT_RESULT,
      sessionId: payload.sessionId,
      route: "veadk",
      speechText: "我暂时无法完成这个请求。",
      displayText: error.message,
      audioBase64: null,
      audioMimeType: null,
      meta: { intent, phase: "final" },
      timing: {
        asrMs: t1 - t0,
        agentMs: 0,
        ttsMs: 0,
        totalMs: Date.now() - t0
      }
    });
  }

  send(
    ws,
    createSessionState(SessionState.SPEAKING, "Assistant response ready.", payload.sessionId)
  );
  send(
    ws,
    createSessionState(SessionState.LISTENING, "Waiting for the next utterance.", payload.sessionId)
  );
}

async function handlePhotoCapture(ws, payload) {
  const t0 = Date.now();
  send(
    ws,
    createSessionState(SessionState.THINKING, "Analyzing captured image.", payload.sessionId)
  );

  const session = sessions.get(payload.sessionId);
  const photoText = session?.pendingPhotoText || payload.text || "";
  if (session) {
    session.pendingPhotoText = null;
  }

  try {
    const result = await streamVeadkToClient(ws, {
      sessionId: payload.sessionId,
      userId: session?.userId || payload.userId || "",
      text: photoText,
      imageDataUrl: payload.dataUrl,
      intent: Intent.IMAGE_UNDERSTANDING
    }, { t0, intent: Intent.IMAGE_UNDERSTANDING, withTiming: true });

    send(ws, {
      type: ServerEvent.ASSISTANT_RESULT,
      sessionId: payload.sessionId,
      route: "veadk",
      speechText: result.allSpeechText,
      displayText: result.allDisplayText,
      audioBase64: null,
      audioMimeType: null,
      meta: { intent: Intent.IMAGE_UNDERSTANDING, phase: "final" },
      timing: result.timing
    });
  } catch (error) {
    console.error("[gateway] photo veadk stream error:", error.message);
    send(ws, {
      type: ServerEvent.ASSISTANT_RESULT,
      sessionId: payload.sessionId,
      route: "veadk",
      speechText: "图片分析失败。",
      displayText: error.message,
      audioBase64: null,
      audioMimeType: null,
      meta: { intent: Intent.IMAGE_UNDERSTANDING, phase: "final" },
      timing: {
        asrMs: 0,
        agentMs: 0,
        ttsMs: 0,
        totalMs: Date.now() - t0
      }
    });
  }

  send(
    ws,
    createSessionState(SessionState.SPEAKING, "Image understanding ready.", payload.sessionId)
  );
  send(
    ws,
    createSessionState(SessionState.LISTENING, "Waiting for the next utterance.", payload.sessionId)
  );
}

function createGatewaySession(sessionId, ws, userId) {
  const session = {
    ws,
    userId: userId || "",
    state: SessionState.LISTENING,
    queue: [],
    processing: false,
    asrSession: null,
    closed: false,
    lastAudioChunkAt: 0
  };

  if (!volcAsrClient.isConfigured()) {
    return session;
  }

  session.asrSession = volcAsrClient.createSession({
    sessionId,
    format: "pcm",
    sampleRate: 16000,
    bits: 16,
    channel: 1,
    onPartial: (text) => {
      send(ws, {
        type: ServerEvent.TRANSCRIPT_PARTIAL,
        sessionId,
        text
      });
    },
    onUtterance: (text) => {
      enqueueTranscript(sessionId, ws, text, "volc-asr");
    },
    onError: (error) => {
      send(ws, {
        type: ServerEvent.ASSISTANT_ERROR,
        sessionId,
        message: `ASR error: ${error.message}`
      });
    }
  });

  session.asrSession.start().catch((error) => {
    console.error(`[gateway] ASR session ${sessionId} start failed:`, error.message);
    session.asrSession = null;
    send(ws, {
      type: ServerEvent.ASSISTANT_ERROR,
      sessionId,
      message: `语音识别服务启动失败: ${error.message}，请尝试重启会话。`
    });
  });

  return session;
}

function enqueueTranscript(sessionId, ws, text, source) {
  const session = sessions.get(sessionId);
  if (!session || session.closed || !text?.trim()) {
    return;
  }

  session.queue.push({
    type: ClientEvent.TRANSCRIPT_USER,
    sessionId,
    userId: session.userId || "",
    text: text.trim(),
    source,
    receivedAt: Date.now(),
    asrAudioEndAt: session.lastAudioChunkAt || Date.now()
  });
  void drainTranscriptQueue(sessionId, ws);
}

async function drainTranscriptQueue(sessionId, ws) {
  const session = sessions.get(sessionId);
  if (!session || session.closed || session.processing) {
    return;
  }

  session.processing = true;
  try {
    while (session.queue.length) {
      const payload = session.queue.shift();
      send(ws, {
        type: ServerEvent.TRANSCRIPT_PARTIAL,
        sessionId,
        text: payload.text
      });
      await handleUserTranscript(ws, payload);
    }
  } finally {
    session.processing = false;
  }
}

async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }

  session.closed = true;
  session.queue.length = 0;
  sessions.delete(sessionId);
  if (session.asrSession) {
    await session.asrSession.finishAndWait(1500).catch(() => {
      session.asrSession.close();
    });
  }
  console.log(`[gateway] session ${sessionId} closed`);
}

wss.on("connection", (ws) => {
  ws.on("message", async (message) => {
    const payload = JSON.parse(message.toString());

    try {
      switch (payload.type) {
        case ClientEvent.SESSION_START:
          console.log(`[gateway] SESSION_START sessionId=${payload.sessionId}, existing=${sessions.has(payload.sessionId)}`);
          if (sessions.has(payload.sessionId)) {
            console.log(`[gateway] closing stale session ${payload.sessionId} before creating new one`);
            await closeSession(payload.sessionId);
          }
          sessions.set(payload.sessionId, createGatewaySession(payload.sessionId, ws, payload.userId));
          send(
            ws,
            createSessionState(
              SessionState.LISTENING,
              "Conversation started. Waiting for speech input.",
              payload.sessionId
            )
          );
          break;
        case ClientEvent.SESSION_STOP:
          await closeSession(payload.sessionId);
          send(
            ws,
            createSessionState(SessionState.IDLE, "Conversation stopped.", payload.sessionId)
          );
          break;
        case ClientEvent.TRANSCRIPT_USER:
          enqueueTranscript(payload.sessionId, ws, payload.text, payload.source || "manual");
          break;
        case ClientEvent.AUDIO_CHUNK: {
          const session = sessions.get(payload.sessionId);
          if (session) {
            session.lastAudioChunkAt = Date.now();
            session.asrSession?.writeAudio(Buffer.from(payload.audioBase64, "base64"));
          }
          break;
        }
        case ClientEvent.PHOTO_CAPTURE:
          await handlePhotoCapture(ws, payload);
          break;
        default:
          send(ws, {
            type: ServerEvent.ASSISTANT_ERROR,
            sessionId: payload.sessionId,
            message: `Unsupported event type: ${payload.type}`
          });
          break;
      }
    } catch (error) {
      send(ws, {
        type: ServerEvent.ASSISTANT_ERROR,
        sessionId: payload.sessionId,
        message: error.message
      });
    }
  });

  ws.on("close", () => {
    for (const [sessionId, session] of sessions.entries()) {
      if (session.ws === ws) {
        void closeSession(sessionId);
      }
    }
  });
});
