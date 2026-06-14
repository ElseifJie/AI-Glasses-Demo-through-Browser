import {
  ClientEvent,
  ServerEvent,
  SessionState
} from "@ai-glasses/shared";
import "./styles.css";

const sessionId = crypto.randomUUID();
const USER_ID_KEY = "ai-glasses-user-id";
const userId = (() => {
  const stored = localStorage.getItem(USER_ID_KEY);
  if (stored) return stored;
  const id = crypto.randomUUID();
  localStorage.setItem(USER_ID_KEY, id);
  return id;
})();
const gatewayUrl =
  (globalThis.location.protocol === "https:" ? "wss://" : "ws://") +
  (globalThis.location.hostname || "localhost") +
  ":8787";

const HISTORY_KEY = "ai-glasses-history";

const state = {
  sessionActive: false,
  sessionState: SessionState.IDLE,
  transcript: "",
  conversation: [],
  tasks: [],
  lastPhoto: "",
  lastTiming: null,
  mediaStream: null,
  ws: null,
  audioContext: null,
  sourceNode: null,
  processorNode: null,
  gainNode: null,
  pcmBuffer: [],
  pcmBufferSize: 0,
  activeAudio: null,
  playbackAudioCtx: null,
  audioQueue: [],
  audioPlaying: false,
  audioNextPlayTime: 0
};

const app = document.querySelector("#app");
app.innerHTML = `
  <main class="shell">
    <header class="top-bar">
      <h1>AI 智能眼镜</h1>
      <div style="display:flex;align-items:center;gap:10px;">
        <span class="status-badge">
          <span class="status-dot" id="statusDot"></span>
          <span id="statusLabel">待命中</span>
        </span>
        <button id="historyButton" class="ghost">📋 历史记录</button>
      </div>
    </header>

    <section class="main-area">
      <div class="camera-panel">
        <span class="camera-label">📷 实时画面</span>
        <video id="cameraPreview" autoplay playsinline muted></video>
        <canvas id="captureCanvas" hidden></canvas>
      </div>

      <div class="chat-panel">
        <div class="chat-header">对话记录</div>
        <div id="messageList" class="chat-scroll">
          <p class="empty-hint">点击「开始对话」与 AI 智能眼镜交互</p>
        </div>
      </div>
    </section>

    <section class="control-bar">
      <button id="startButton" class="primary">🎤 开始对话</button>
      <button id="stopButton" class="secondary" disabled>⏹ 结束对话</button>
      <button id="photoButton" class="secondary" disabled>📷 拍照</button>
    </section>

    <section class="conv-log" id="convLog">
      <div class="chat-header">交互链路与时延分析</div>
      <div id="latencyList" class="chat-scroll">
        <p class="empty-hint">暂无交互数据</p>
      </div>
    </section>
  </main>

  <div id="historyModal" class="modal hidden">
    <div class="modal-content">
      <div class="modal-header">
        <h2>历史对话记录</h2>
        <button id="closeHistory" class="ghost">✕</button>
      </div>
      <div id="historyList" class="history-list"></div>
      <div class="modal-footer">
        <button id="clearHistory" class="danger">清空全部记录</button>
      </div>
    </div>
  </div>
`;

const $ = (sel) => document.querySelector(sel);

const startButton = $("#startButton");
const stopButton = $("#stopButton");
const photoButton = $("#photoButton");
const historyButton = $("#historyButton");
const closeHistoryBtn = $("#closeHistory");
const clearHistoryBtn = $("#clearHistory");
const statusLabel = $("#statusLabel");
const statusDot = $("#statusDot");
const messageList = $("#messageList");
const latencyList = $("#latencyList");
const cameraPreview = $("#cameraPreview");
const captureCanvas = $("#captureCanvas");
const historyModal = $("#historyModal");
const historyListEl = $("#historyList");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHistory(entry) {
  const records = loadHistory();
  records.unshift(entry);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(records.slice(0, 200)));
}

function deleteHistory(index) {
  const records = loadHistory();
  records.splice(index, 1);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(records));
  renderHistoryModal();
}

function clearAllHistory() {
  localStorage.removeItem(HISTORY_KEY);
  renderHistoryModal();
}

function renderHistoryModal() {
  const records = loadHistory();
  if (!records.length) {
    historyListEl.innerHTML = '<p class="empty-hint">暂无历史记录</p>';
    return;
  }
  historyListEl.innerHTML = records
    .map((item, i) => {
      const routeCls =
        item.route === "arkclaw" ? "arkclaw" : "veadk";
      const routeLabel =
        item.route === "arkclaw" ? "ArkClaw" : "VeADK";
      const timing = item.timing;
      const timingHtml = timing
        ? `<div class="h-latency">
            <span class="seg ${timing.asrMs < 500 ? "g" : timing.asrMs < 1500 ? "w" : "b"}">🎙️ ASR时延 ${timing.asrMs}ms</span>
            <span class="arw">→</span>
            <span class="seg ${timing.agentMs < 500 ? "g" : timing.agentMs < 1500 ? "w" : "b"}">🧠 Agent时延 ${timing.agentMs}ms</span>
            <span class="arw">→</span>
            <span class="seg ${timing.ttsMs < 500 ? "g" : timing.ttsMs < 1500 ? "w" : "b"}">🔊 TTS时延 ${timing.ttsMs}ms</span>
            <span class="arw">=</span>
            <span class="seg ${timing.totalMs < 500 ? "g" : timing.totalMs < 1500 ? "w" : "b"}">端到端总计 ${timing.totalMs}ms</span>
          </div>`
        : "";
      return `
        <div class="history-item">
          <div class="h-info">
            <div class="h-time">${escapeHtml(item.time)}</div>
            <div class="h-round">
              <div class="h-user">🙋 ${escapeHtml(item.userText)}</div>
              <div class="h-agent">
                <span class="h-route ${routeCls}">${routeLabel}</span>
                ${escapeHtml(item.displayText)}
              </div>
              ${timingHtml}
            </div>
          </div>
          <button class="h-delete" data-idx="${i}">🗑</button>
        </div>
      `;
    })
    .join("");

  historyListEl.querySelectorAll(".h-delete").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx, 10);
      deleteHistory(idx);
    });
  });
}

function openHistory() {
  renderHistoryModal();
  historyModal.classList.remove("hidden");
}

function closeHistory() {
  historyModal.classList.add("hidden");
}

historyButton.addEventListener("click", openHistory);
closeHistoryBtn.addEventListener("click", closeHistory);
clearHistoryBtn.addEventListener("click", clearAllHistory);
historyModal.addEventListener("click", (e) => {
  if (e.target === historyModal) closeHistory();
});

function connectGateway() {
  if (state.ws && state.ws.readyState <= WebSocket.OPEN) {
    return state.ws;
  }

  const ws = new WebSocket(gatewayUrl);
  ws.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.sessionId !== sessionId) {
      return;
    }

    switch (payload.type) {
      case ServerEvent.SESSION_STATE:
        state.sessionState = payload.state;
        renderStatus(payload.message);
        if (payload.state === "listening" && !state.sessionActive) {
          state.sessionActive = true;
          startButton.disabled = true;
          stopButton.disabled = false;
          photoButton.disabled = false;
        }
        if (payload.state === "idle") {
          state.sessionActive = false;
          startButton.disabled = false;
          stopButton.disabled = true;
          photoButton.disabled = true;
        }
        break;
      case ServerEvent.TRANSCRIPT_PARTIAL:
        state.transcript = payload.text;
        if (state.audioPlaying) {
          stopAllAudio();
        }
        renderStreamingTranscript(payload.text);
        break;
      case ServerEvent.ASSISTANT_RESULT:
        state.lastTiming = payload.timing || null;

        removeStreamingTranscript();

        state._audioMuted = false;

        const isAck = payload.meta?.phase === "ack";
        const isResult = payload.meta?.phase === "result";
        const isSentence = payload.meta?.phase === "sentence";
        const isFinal = payload.meta?.phase === "final";
        let phDedup = false;

        if (isSentence) {
          if (!state._streaming) {
            if (payload.meta?.intent === "image_understanding") {
              const phIdx = state.conversation.findIndex(
                (item) => item.type === "agent" && item._placeholder
              );
              if (phIdx >= 0) {
                state.conversation[phIdx] = {
                  type: "agent",
                  route: payload.route || "veadk",
                  displayText: payload.displayText || "",
                  speechText: payload.speechText || "",
                  timing: null,
                  isAck: false
                };
                state._streaming = state.conversation[phIdx];
                phDedup = true;
              }
            }
            if (!phDedup) {
              state.conversation.push({
                type: "user",
                text: state.transcript || "(语音输入)"
              });
              state._streaming = {
                type: "agent",
                route: payload.route || "veadk",
                displayText: payload.displayText || "",
                speechText: payload.speechText || "",
                timing: null,
                isAck: false
              };
              state.conversation.push(state._streaming);
            }
          } else {
            state._streaming.displayText += payload.displayText;
            state._streaming.speechText += payload.speechText;
          }
          renderMessages();
          playAssistantAudio(payload);
          break;
        }

        if (isFinal) {
          if (state._streaming) {
            state._streaming.displayText = payload.displayText || state._streaming.displayText;
            state._streaming.speechText = payload.speechText || state._streaming.speechText;
            state._streaming.timing = payload.timing || null;
            saveHistory({
              time: new Date().toLocaleString("zh-CN"),
              route: payload.route || "veadk",
              userText: state.transcript || "(语音输入)",
              displayText: state._streaming.displayText || "",
              speechText: state._streaming.speechText || "",
              timing: payload.timing || null
            });
            state._streaming = null;
            state.transcript = "";
            renderMessages();
            renderLatencyLog();
          }
          playAssistantAudio(payload);
          break;
        }

        console.log("[frontend] ASSISTANT_RESULT phase=%s route=%s displayText=%s",
          payload.meta?.phase, payload.route, (payload.displayText || "").slice(0, 40));

        if (!isResult) {
          state.conversation.push({
            type: "user",
            text: state.transcript || "(语音输入)"
          });
        }

        state.conversation.push({
          type: "agent",
          route: payload.route || "veadk",
          displayText: isAck ? `⏳ ${payload.displayText}` : payload.displayText || "",
          speechText: payload.speechText || "",
          timing: payload.timing || null,
          isAck
        });

        renderMessages();
        renderLatencyLog();
        playAssistantAudio(payload);

        if (isResult) {
          const lastUser = [...state.conversation].reverse().find(
            (item) => item.type === "user"
          );
          saveHistory({
            time: new Date().toLocaleString("zh-CN"),
            route: payload.route || "veadk",
            userText: lastUser?.text || "(语音输入)",
            displayText: payload.displayText || "",
            speechText: payload.speechText || "",
            timing: payload.timing || null
          });
        } else if (!isAck) {
          saveHistory({
            time: new Date().toLocaleString("zh-CN"),
            route: payload.route || "veadk",
            userText: state.transcript || "(语音输入)",
            displayText: payload.displayText || "",
            speechText: payload.speechText || "",
            timing: payload.timing || null
          });
          state.transcript = "";
        }
        break;
      case ServerEvent.ASSISTANT_TASK:
        {
          const existing = state.tasks.find((t) => t.taskId === payload.taskId);
          if (existing) {
            existing.status = payload.status;
            existing.detail = payload.detail;
          } else {
            state.tasks.unshift(payload);
          }
          state.conversation.push({
            type: "task",
            ...payload
          });
          renderMessages();
        }
        break;
      case ServerEvent.ASSISTANT_ERROR:
        state.conversation.push({
          type: "error",
          message: payload.message
        });
        renderMessages();
        break;
      case ServerEvent.CAPTURE_PHOTO_REQUEST:
        handleCapturePhoto(payload.text);
        break;
      default:
        break;
    }
  });

  ws.addEventListener("close", () => {
    state.ws = null;
    if (state.sessionActive) {
      state.sessionActive = false;
      state.sessionState = SessionState.IDLE;
      startButton.disabled = false;
      stopButton.disabled = true;
      photoButton.disabled = true;
      stopMedia();
      renderStatus("连接已断开");
    }
  });

  state.ws = ws;
  return ws;
}

function send(payload) {
  const ws = connectGateway();
  const submit = () => ws.send(JSON.stringify(payload));

  if (ws.readyState === WebSocket.OPEN) {
    submit();
    return;
  }

  ws.addEventListener("open", submit, { once: true });
}

function renderStatus(message) {
  statusLabel.textContent = message;
  if (state.sessionState === SessionState.IDLE) {
    statusDot.className = "status-dot";
  } else {
    statusDot.className = "status-dot active";
  }
}

function formatTiming(timing) {
  if (!timing) {
    return "";
  }

  const { asrMs, agentMs, ttsMs, totalMs, ttftMs, ttfaMs } = timing;
  const cls = (ms) => (ms < 500 ? "good" : ms < 1500 ? "warn" : "bad");

  const parts = [];
  if (ttftMs != null) {
    parts.push(`<span class="segment ttfr">📝 文字首响 ${ttftMs}ms</span>`);
  }
  if (ttfaMs != null) {
    parts.push(`<span class="segment ttfa">🔊 语音首响 ${ttfaMs}ms</span>`);
  }
  if (ttftMs != null || ttfaMs != null) {
    parts.push(`<span class="arrow">|</span>`);
  }
  if (asrMs > 0) {
    parts.push(
      `<span class="segment ${cls(asrMs)}">🎙️ ASR时延 ${asrMs}ms</span>`,
      `<span class="arrow">→</span>`
    );
  }
  parts.push(
    `<span class="segment ${cls(agentMs)}">🧠 Agent时延 ${agentMs}ms</span>`,
    `<span class="arrow">→</span>`,
    `<span class="segment ${cls(ttsMs)}">🔊 TTS时延 ${ttsMs}ms</span>`,
    `<span class="arrow">=</span>`,
    `<span class="segment ${cls(totalMs)}">端到端总计 ${totalMs}ms</span>`
  );
  return parts.join(" ");
}

function _getAudioCtx() {
  if (!state.playbackAudioCtx) {
    state.playbackAudioCtx = new AudioContext();
  }
  if (state.playbackAudioCtx.state === "suspended") {
    state.playbackAudioCtx.resume();
  }
  return state.playbackAudioCtx;
}

async function playAssistantAudio(payload) {
  if (!payload.audioBase64 || !payload.audioMimeType) {
    return;
  }

  if (state._audioMuted) {
    return;
  }

  const ctx = _getAudioCtx();
  const binary = atob(payload.audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  try {
    const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
    state.audioQueue.push(audioBuffer);
    if (!state.audioPlaying) {
      _playAudioQueue(ctx);
    }
  } catch (e) {
    console.warn("[audio] decode failed:", e);
  }
}

function _playAudioQueue(ctx) {
  if (!state.audioQueue.length) {
    state.audioPlaying = false;
    state.audioNextPlayTime = 0;
    return;
  }
  state.audioPlaying = true;

  const buffer = state.audioQueue.shift();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);

  const now = ctx.currentTime;
  const startTime = Math.max(now, state.audioNextPlayTime);
  source.start(startTime);
  state.audioNextPlayTime = startTime + buffer.duration;
  source.onended = () => _playAudioQueue(ctx);
}

function stopAllAudio() {
  console.log("[audio] interrupt: stopping all audio");
  state.audioQueue = [];
  state.audioPlaying = false;
  state.audioNextPlayTime = 0;
  state._audioMuted = true;
  if (state.playbackAudioCtx) {
    state.playbackAudioCtx.close().catch(() => {});
    state.playbackAudioCtx = null;
  }
}

function renderMessages() {
  if (!state.conversation.length) {
    messageList.innerHTML =
      '<p class="empty-hint">点击「开始对话」与 AI 智能眼镜交互</p>';
    return;
  }

  messageList.innerHTML = state.conversation
    .map((item) => {
      if (item.type === "user") {
        return `
          <div class="message-bubble user">
            <p class="msg-text">${escapeHtml(item.text)}</p>
          </div>
        `;
      }

      if (item.type === "task") {
        const statusIcon = item.status === "running" ? "⏳" : item.status === "completed" ? "✅" : item.status === "blocked" ? "🚫" : "❌";
        return `
          <div class="message-bubble task">
            <span class="task-status">${statusIcon} ${escapeHtml(item.title)}</span>
            <p class="task-detail">${escapeHtml(item.detail || "")}</p>
          </div>
        `;
      }

      if (item.type === "error") {
        return `
          <div class="message-bubble error">
            <span class="error-icon">⚠️</span>
            <p class="msg-text">${escapeHtml(item.message)}</p>
          </div>
        `;
      }

      const isVeadk = item.route !== "arkclaw";
      const roleLabel = isVeadk ? "VeADK" : "ArkClaw";
      const roleCls = isVeadk ? "veadk" : "arkclaw";
      return `
        <div class="message-bubble agent">
          <span class="role-tag ${roleCls}">${roleLabel}</span>
          <p class="msg-text">${escapeHtml(item.displayText)}</p>
          ${item.speechText ? `<p class="msg-speech">🔊 ${escapeHtml(item.speechText)}</p>` : ""}
        </div>
      `;
    })
    .join("");

  messageList.scrollTop = messageList.scrollHeight;
}

function renderLatencyLog() {
  const entries = state.conversation.filter((item) => item.type === "agent" && item.timing);

  if (!entries.length) {
    latencyList.innerHTML =
      '<p class="empty-hint">暂无交互数据</p>';
    return;
  }

  const isVeadk = (item) => item.route !== "arkclaw";
  const roleLabel = (item) => (isVeadk(item) ? "VeADK" : "ArkClaw");
  const roleCls = (item) => (isVeadk(item) ? "veadk" : "arkclaw");

  latencyList.innerHTML = entries
    .map(
      (item) => `
        <div class="latency-row">
          <span class="role-tag ${roleCls(item)}">${roleLabel(item)}</span>
          <span class="latency-intent">${escapeHtml(item.displayText.slice(0, 40))}</span>
          ${formatTiming(item.timing)}
        </div>
      `
    )
    .join("");

  latencyList.scrollTop = latencyList.scrollHeight;
}

function renderStreamingTranscript(text) {
  if (!text) {
    return;
  }

  let el = document.getElementById("streamingTranscript");
  if (!el) {
    el = document.createElement("div");
    el.id = "streamingTranscript";
    el.className = "message-bubble user streaming";
    el.innerHTML = '<p class="msg-text">🎤 </p>';
    messageList.appendChild(el);
  }

  el.querySelector(".msg-text").textContent = `🎤 ${text}`;
  messageList.scrollTop = messageList.scrollHeight;
}

function removeStreamingTranscript() {
  const el = document.getElementById("streamingTranscript");
  if (el) {
    el.remove();
  }
}

async function startMedia() {
  state.mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 }
    }
  });
  cameraPreview.srcObject = state.mediaStream;
}

function downsampleTo16k(samples, sourceRate) {
  if (sourceRate === 16000) {
    return samples;
  }

  const ratio = sourceRate / 16000;
  const newLength = Math.round(samples.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (
      let i = offsetBuffer;
      i < nextOffsetBuffer && i < samples.length;
      i += 1
    ) {
      sum += samples[i];
      count += 1;
    }
    result[offsetResult] = count > 0 ? sum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function floatTo16BitPcm(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(
      i * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true
    );
  }
  return new Uint8Array(buffer);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function flushAudioChunk() {
  if (!state.pcmBufferSize) {
    return;
  }

  const merged = new Float32Array(state.pcmBufferSize);
  let offset = 0;
  for (const chunk of state.pcmBuffer) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  state.pcmBuffer = [];
  state.pcmBufferSize = 0;

  const pcm16 = floatTo16BitPcm(merged);
  send({
    type: ClientEvent.AUDIO_CHUNK,
    sessionId,
    format: "pcm",
    sampleRate: 16000,
    audioBase64: bytesToBase64(pcm16)
  });
}

async function startAudioStreaming() {
  const audioContext = new AudioContext();
  await audioContext.resume();

  const sourceNode = audioContext.createMediaStreamSource(state.mediaStream);
  const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  const gainNode = audioContext.createGain();
  gainNode.gain.value = 0;

  processorNode.onaudioprocess = (event) => {
    if (!state.sessionActive) {
      return;
    }
    const input = event.inputBuffer.getChannelData(0);
    const downsampled = downsampleTo16k(input, audioContext.sampleRate);
    state.pcmBuffer.push(downsampled);
    state.pcmBufferSize += downsampled.length;

    if (state.pcmBuffer.length === 1 || state.pcmBufferSize >= 2400) {
      flushAudioChunk();
    }
  };

  sourceNode.connect(processorNode);
  processorNode.connect(gainNode);
  gainNode.connect(audioContext.destination);

  state.audioContext = audioContext;
  state.sourceNode = sourceNode;
  state.processorNode = processorNode;
  state.gainNode = gainNode;
}

function stopMedia() {
  flushAudioChunk();
  state.mediaStream?.getTracks().forEach((track) => track.stop());
  state.mediaStream = null;
  cameraPreview.srcObject = null;
  if (state.processorNode) {
    state.processorNode.disconnect();
    state.processorNode = null;
  }
  if (state.gainNode) {
    state.gainNode.disconnect();
    state.gainNode = null;
  }
  if (state.sourceNode) {
    state.sourceNode.disconnect();
    state.sourceNode = null;
  }
  state.audioContext?.close().catch(() => {});
  state.audioContext = null;
  state.pcmBuffer = [];
  state.pcmBufferSize = 0;
  state.activeAudio?.pause();
  state.activeAudio = null;
}

async function handleStart() {
  await startMedia();
  await startAudioStreaming();
  send({
    type: ClientEvent.SESSION_START,
    sessionId,
    userId
  });
  state.sessionState = SessionState.LISTENING;
  startButton.disabled = true;
  stopButton.disabled = false;
  photoButton.disabled = false;
  renderStatus("正在聆听…");
}

function handleStop() {
  state.sessionActive = false;
  state.sessionState = SessionState.IDLE;
  startButton.disabled = false;
  stopButton.disabled = true;
  photoButton.disabled = true;
  stopMedia();
  renderStatus("对话已结束");
  send({
    type: ClientEvent.SESSION_STOP,
    sessionId
  });
}

const MAX_IMAGE_DIM = 640;

function handleCapturePhoto(voiceText = "") {
  if (!state.mediaStream) {
    return;
  }

  const srcWidth = cameraPreview.videoWidth || 1280;
  const srcHeight = cameraPreview.videoHeight || 720;
  let dstWidth = srcWidth;
  let dstHeight = srcHeight;
  if (srcWidth > MAX_IMAGE_DIM || srcHeight > MAX_IMAGE_DIM) {
    const ratio = Math.min(MAX_IMAGE_DIM / srcWidth, MAX_IMAGE_DIM / srcHeight);
    dstWidth = Math.round(srcWidth * ratio);
    dstHeight = Math.round(srcHeight * ratio);
  }
  captureCanvas.width = dstWidth;
  captureCanvas.height = dstHeight;
  const context = captureCanvas.getContext("2d");
  context.drawImage(cameraPreview, 0, 0, dstWidth, dstHeight);
  const dataUrl = captureCanvas.toDataURL("image/jpeg", 0.6);
  state.lastPhoto = dataUrl;

  const userLabel = voiceText || "📷 拍照";

  state.conversation.push({
    type: "user",
    text: userLabel
  });
  state.conversation.push({
    type: "agent",
    route: "veadk",
    displayText: "📷 正在分析拍摄的照片…",
    speechText: "",
    timing: null,
    _placeholder: true
  });
  renderMessages();
  renderLatencyLog();

  send({
    type: ClientEvent.PHOTO_CAPTURE,
    sessionId,
    userId,
    mimeType: "image/jpeg",
    dataUrl,
    text: voiceText
  });
}

startButton.addEventListener("click", () => {
  handleStart().catch((error) => {
    renderStatus(`启动失败: ${error.message}`);
  });
});
stopButton.addEventListener("click", handleStop);
photoButton.addEventListener("click", handleCapturePhoto);

renderStatus("待命中");
