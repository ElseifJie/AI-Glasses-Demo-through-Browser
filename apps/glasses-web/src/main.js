import {
  ClientEvent,
  ServerEvent,
  SessionState
} from "@ai-glasses/shared";
import {
  deleteMediaItem,
  getMediaItem,
  listMediaItems,
  saveMediaItem
} from "./media-library.js";
import "./styles.css";

const sessionId = crypto.randomUUID();
const USER_ID_KEY = "ai-glasses-user-id";
const HISTORY_KEY = "ai-glasses-history";
const GATEWAY_URL_KEY = "ai-glasses-gateway-url";
const MAX_IMAGE_DIM = 640;
const userId = (() => {
  const stored = localStorage.getItem(USER_ID_KEY);
  if (stored) return stored;
  const id = crypto.randomUUID();
  localStorage.setItem(USER_ID_KEY, id);
  return id;
})();

function toWebSocketUrl(value) {
  if (!value) return "";
  if (/^wss?:\/\//i.test(value)) return value;
  if (/^https?:\/\//i.test(value)) return value.replace(/^http/i, "ws");
  return value;
}

function resolveGatewayUrl() {
  const stored = globalThis.localStorage?.getItem(GATEWAY_URL_KEY) || "";
  const configured =
    stored ||
    import.meta.env.VITE_GATEWAY_WS_URL ||
    globalThis.__AI_GLASSES_CONFIG__?.gatewayWsUrl ||
    "";

  if (configured) {
    return toWebSocketUrl(configured);
  }

  const protocol = globalThis.location.protocol === "https:" ? "wss://" : "ws://";
  const hostname = globalThis.location.hostname || "localhost";
  return `${protocol}${hostname}:8787`;
}

function toHttpBase(wsUrl) {
  return wsUrl.replace(/^ws/i, "http");
}

const gatewayUrl = resolveGatewayUrl();
const gatewayHttpBase = toHttpBase(gatewayUrl);

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
  audioNextPlayTime: 0,
  audioFallbackQueue: [],
  audioFallbackPlaying: false,
  mediaItems: [],
  albumFilter: "all",
  mediaPreviewUrls: new Map(),
  albumSelectionRequest: null,
  isRecordingVideo: false,
  mediaRecorder: null,
  videoChunks: [],
  currentRecordingLabel: "",
  recordingStartedAt: 0,
  _audioMutedTimer: null,
  _streamingEl: null,
  _reconnectAttempts: 0,
  _reconnectTimer: null
};

const app = document.querySelector("#app");
app.innerHTML = `
  <main class="shell">
    <header class="top-bar">
      <h1>AI 智能眼镜</h1>
      <div class="top-actions">
        <span class="status-badge">
          <span class="status-dot" id="statusDot"></span>
          <span id="statusLabel">待命中</span>
        </span>
        <button id="albumButton" class="ghost">🗂 相册</button>
        <button id="historyButton" class="ghost">📋 历史记录</button>
      </div>
    </header>

    <section class="main-area">
      <div class="camera-panel">
        <span class="camera-label" id="cameraLabel">📷 实时画面</span>
        <video id="cameraPreview" autoplay playsinline muted></video>
        <canvas id="captureCanvas" hidden></canvas>
        <div id="recordingBadge" class="recording-badge hidden">● 录制中</div>
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
      <button id="videoButton" class="secondary" disabled>🎬 录视频</button>
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

  <div id="albumModal" class="modal hidden">
    <div class="modal-content album-modal-content">
      <div class="modal-header">
        <div>
          <h2>本地相册</h2>
          <p id="albumModeHint" class="modal-subtitle">浏览本机保存的照片与视频</p>
        </div>
        <button id="closeAlbum" class="ghost">✕</button>
      </div>
      <div class="album-tabs">
        <button data-filter="all" class="album-tab active">全部</button>
        <button data-filter="photo" class="album-tab">照片</button>
        <button data-filter="video" class="album-tab">视频</button>
        <button data-filter="creation" class="album-tab">作品</button>
      </div>
      <div id="albumList" class="album-list"></div>
    </div>
  </div>
`;

const $ = (sel) => document.querySelector(sel);

const startButton = $("#startButton");
const stopButton = $("#stopButton");
const photoButton = $("#photoButton");
const videoButton = $("#videoButton");
const albumButton = $("#albumButton");
const historyButton = $("#historyButton");
const closeHistoryBtn = $("#closeHistory");
const clearHistoryBtn = $("#clearHistory");
const closeAlbumBtn = $("#closeAlbum");
const statusLabel = $("#statusLabel");
const statusDot = $("#statusDot");
const messageList = $("#messageList");
const latencyList = $("#latencyList");
const cameraPreview = $("#cameraPreview");
const captureCanvas = $("#captureCanvas");
const historyModal = $("#historyModal");
const historyListEl = $("#historyList");
const albumModal = $("#albumModal");
const albumListEl = $("#albumList");
const albumModeHintEl = $("#albumModeHint");
const cameraLabel = $("#cameraLabel");
const recordingBadge = $("#recordingBadge");

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

async function refreshMediaItems() {
  state.mediaItems = await listMediaItems();
  if (!albumModal.classList.contains("hidden")) {
    renderAlbumModal();
  }
}

function getPreviewUrl(item) {
  if (state.mediaPreviewUrls.has(item.id)) {
    return state.mediaPreviewUrls.get(item.id);
  }
  const url = URL.createObjectURL(item.blob);
  state.mediaPreviewUrls.set(item.id, url);
  return url;
}

function revokePreviewUrl(id) {
  const existing = state.mediaPreviewUrls.get(id);
  if (existing) {
    URL.revokeObjectURL(existing);
    state.mediaPreviewUrls.delete(id);
  }
}

async function persistMediaItem(item) {
  await saveMediaItem(item);
  await refreshMediaItems();
}

async function downloadAndSaveCreations(mediaItems) {
  for (const item of mediaItems) {
    try {
      const proxyUrl = `${gatewayHttpBase}/api/tos/proxy?url=${encodeURIComponent(item.downloadUrl)}`;
      const response = await fetch(proxyUrl);
      if (!response.ok) {
        console.error("[glasses-web] failed to download creation:", item.fileName, response.status);
        continue;
      }
      const blob = await response.blob();
      await persistMediaItem({
        id: crypto.randomUUID(),
        kind: "creation",
        blob,
        mimeType: blob.type || "video/mp4",
        fileName: item.fileName || `creation-${Date.now()}.mp4`,
        createdAt: Date.now(),
        sourceText: "视频剪辑作品"
      });
    } catch (error) {
      console.error("[glasses-web] downloadAndSaveCreations error:", error.message);
    }
  }
}

function renderHistoryModal() {
  const records = loadHistory();
  if (!records.length) {
    historyListEl.innerHTML = '<p class="empty-hint">暂无历史记录</p>';
    return;
  }

  historyListEl.innerHTML = records
    .map((item, i) => {
      const routeCls = item.route === "arkclaw" ? "arkclaw" : item.route === "gateway" ? "gateway" : "veadk";
      const routeLabel = item.route === "arkclaw" ? "ArkClaw" : item.route === "gateway" ? "Gateway" : "VeADK";
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
      deleteHistory(parseInt(btn.dataset.idx, 10));
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

function openAlbum() {
  renderAlbumModal();
  albumModal.classList.remove("hidden");
}

function closeAlbum(force = false) {
  if (state.albumSelectionRequest && !force) {
    return;
  }
  albumModal.classList.add("hidden");
  // Revoke all preview URLs when album closes to free memory
  for (const url of state.mediaPreviewUrls.values()) {
    URL.revokeObjectURL(url);
  }
  state.mediaPreviewUrls.clear();
}

function renderAlbumTabs() {
  document.querySelectorAll(".album-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === state.albumFilter);
  });
}

function formatMediaTime(timestamp) {
  return new Date(timestamp).toLocaleString("zh-CN");
}

function formatDuration(durationMs) {
  if (!durationMs) return "";
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function renderAlbumModal() {
  renderAlbumTabs();
  albumModeHintEl.textContent = state.albumSelectionRequest
    ? state.albumSelectionRequest.message
    : "浏览本机保存的照片与视频";

  const items = state.mediaItems.filter((item) => {
    if (state.albumFilter === "all") return true;
    if (state.albumFilter === "creation") return item.kind === "creation";
    return item.kind === state.albumFilter && item.kind !== "creation";
  });

  if (!items.length) {
    albumListEl.innerHTML = '<p class="empty-hint">相册里还没有内容</p>';
    return;
  }

  albumListEl.innerHTML = items.map((item) => {
    const previewUrl = getPreviewUrl(item);
    const isVideo = item.kind === "video" || item.kind === "creation";
    const meta = isVideo
      ? `视频 · ${formatDuration(item.durationMs)}`
      : "照片";
    const selectionButton = state.albumSelectionRequest && item.kind === "video"
      ? `<button class="primary album-action" data-action="select" data-id="${item.id}">选择此视频</button>`
      : "";
    return `
      <article class="album-card">
        <div class="album-preview">
          ${
            isVideo
              ? `<video src="${previewUrl}" controls preload="metadata"></video>`
              : `<img src="${previewUrl}" alt="${escapeHtml(item.fileName || item.id)}" />`
          }
        </div>
        <div class="album-card-body">
          <div class="album-card-meta">
            <strong>${escapeHtml(item.fileName || item.id)}</strong>
            <span>${meta}</span>
            <span>${formatMediaTime(item.createdAt)}</span>
          </div>
          <div class="album-card-actions">
            ${selectionButton}
            <a class="secondary album-action" href="${previewUrl}" download="${escapeHtml(item.fileName || "capture")}">下载</a>
            <button class="danger album-action" data-action="delete" data-id="${item.id}">删除</button>
          </div>
        </div>
      </article>
    `;
  }).join("");

  albumListEl.querySelectorAll("[data-action='delete']").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.id;
      revokePreviewUrl(id);
      await deleteMediaItem(id);
      await refreshMediaItems();
    });
  });

  albumListEl.querySelectorAll("[data-action='select']").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const item = await getMediaItem(button.dataset.id);
        if (item) {
          await submitSelectedVideoForEdit(item);
        }
      } catch (error) {
        state.conversation.push({ type: "error", message: `提交视频失败: ${error.message}` });
        renderMessages();
      }
    });
  });
}

historyButton.addEventListener("click", openHistory);
closeHistoryBtn.addEventListener("click", closeHistory);
clearHistoryBtn.addEventListener("click", clearAllHistory);
historyModal.addEventListener("click", (e) => {
  if (e.target === historyModal) closeHistory();
});

albumButton.addEventListener("click", openAlbum);
closeAlbumBtn.addEventListener("click", () => closeAlbum(Boolean(state.albumSelectionRequest)));
albumModal.addEventListener("click", (e) => {
  if (e.target === albumModal) closeAlbum(Boolean(state.albumSelectionRequest));
});
document.querySelectorAll(".album-tab").forEach((button) => {
  button.addEventListener("click", () => {
    state.albumFilter = button.dataset.filter;
    renderAlbumModal();
  });
});

messageList.addEventListener("click", async (e) => {
  const btn = e.target.closest(".save-to-album-btn");
  if (!btn) return;
  const downloadUrl = btn.dataset.url;
  const fileName = btn.dataset.filename;
  if (!downloadUrl) return;
  btn.disabled = true;
  btn.textContent = "保存中...";
  try {
    await downloadAndSaveCreations([{ downloadUrl, fileName }]);
    btn.textContent = "已保存 ✓";
  } catch (err) {
    console.error("[glasses-web] save to album failed:", err);
    btn.textContent = "保存失败";
    btn.disabled = false;
  }
});

function roleInfo(route) {
  if (route === "arkclaw") {
    return { label: "ArkClaw", cls: "arkclaw" };
  }
  if (route === "gateway") {
    return { label: "Gateway", cls: "gateway" };
  }
  return { label: "VeADK", cls: "veadk" };
}

function renderAttachmentList(mediaItems = []) {
  if (!mediaItems.length) return "";
  return `
    <div class="attachment-list">
      ${mediaItems.map((item) => `
        <div class="attachment-card">
          <video src="${item.downloadUrl}" controls preload="metadata"></video>
          <div class="attachment-meta">
            <span>${escapeHtml(item.fileName)}</span>
            <a href="${item.downloadUrl}" download="${escapeHtml(item.fileName)}">下载</a>
            <button class="save-to-album-btn" data-url="${escapeHtml(item.downloadUrl)}" data-filename="${escapeHtml(item.fileName)}">保存到相册</button>
          </div>
        </div>
      `).join("")}
    </div>
  `;
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

      if (item.type === "task" || item._kind === "task") {
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

      const { label, cls } = roleInfo(item.route);
      return `
        <div class="message-bubble agent">
          <span class="role-tag ${cls}">${label}</span>
          <p class="msg-text">${escapeHtml(item.displayText || "")}</p>
          ${item.speechText ? `<p class="msg-speech">🔊 ${escapeHtml(item.speechText)}</p>` : ""}
          ${renderAttachmentList(item.mediaItems || [])}
        </div>
      `;
    })
    .join("");

  messageList.scrollTop = messageList.scrollHeight;
}

function updateLastAgentBubble(streaming) {
  const bubbles = messageList.querySelectorAll(".message-bubble.agent");
  const lastBubble = bubbles[bubbles.length - 1];
  if (!lastBubble) {
    renderMessages();
    return;
  }
  const textEl = lastBubble.querySelector(".msg-text");
  const speechEl = lastBubble.querySelector(".msg-speech");
  if (textEl) textEl.textContent = streaming.displayText || "";
  if (speechEl) speechEl.textContent = streaming.speechText ? `🔊 ${streaming.speechText}` : "";
  messageList.scrollTop = messageList.scrollHeight;
}

function renderStatus(message) {
  statusLabel.textContent = message;
  statusDot.className = state.sessionState === SessionState.IDLE ? "status-dot" : "status-dot active";
  cameraLabel.textContent = state.isRecordingVideo ? "🎬 视频录制中" : "📷 实时画面";
  recordingBadge.classList.toggle("hidden", !state.isRecordingVideo);
  videoButton.textContent = state.isRecordingVideo ? "⏹ 停止录制" : "🎬 录视频";
}

function formatTiming(timing) {
  if (!timing) return "";
  const { asrMs, agentMs, ttsMs, totalMs, ttftMs, ttfaMs, editE2EMs } = timing;
  const cls = (ms) => (ms < 500 ? "good" : ms < 1500 ? "warn" : "bad");
  const parts = [];
  if (editE2EMs != null) {
    parts.push(`<span class="segment ${cls(editE2EMs)}">🎬 剪辑端到端 ${editE2EMs}ms</span>`);
    return parts.join(" ");
  }
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

function renderLatencyLog() {
  const entries = state.conversation.filter((item) => item.type === "agent" && item.timing);
  if (!entries.length) {
    latencyList.innerHTML = '<p class="empty-hint">暂无交互数据</p>';
    return;
  }

  latencyList.innerHTML = entries
    .map((item) => {
      const { label, cls } = roleInfo(item.route);
      return `
        <div class="latency-row">
          <span class="role-tag ${cls}">${label}</span>
          <span class="latency-intent">${escapeHtml((item.displayText || "").slice(0, 40))}</span>
          ${formatTiming(item.timing)}
        </div>
      `;
    })
    .join("");

  latencyList.scrollTop = latencyList.scrollHeight;
}

function renderStreamingTranscript(text) {
  if (!text) return;
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
  document.getElementById("streamingTranscript")?.remove();
}

function connectGateway() {
  if (state.ws && state.ws.readyState <= WebSocket.OPEN) {
    return state.ws;
  }

  const ws = new WebSocket(gatewayUrl);
  ws.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.sessionId !== sessionId) return;

    switch (payload.type) {
      case ServerEvent.SESSION_STATE:
        state.sessionState = payload.state;
        renderStatus(payload.message);
        if (payload.state === "listening" && !state.sessionActive) {
          state.sessionActive = true;
          state._reconnectAttempts = 0;
          clearTimeout(state._reconnectTimer);
          startButton.disabled = true;
          stopButton.disabled = false;
          photoButton.disabled = false;
          videoButton.disabled = false;
        }
        if (payload.state === "idle") {
          state.sessionActive = false;
          startButton.disabled = false;
          stopButton.disabled = true;
          photoButton.disabled = true;
          videoButton.disabled = true;
        }
        break;
      case ServerEvent.TRANSCRIPT_PARTIAL:
        state.transcript = payload.text;
        if (state.audioPlaying) {
          stopAllAudio();
        }
        renderStreamingTranscript(payload.text);
        break;
      case ServerEvent.ASSISTANT_RESULT: {
        state.lastTiming = payload.timing || null;
        removeStreamingTranscript();
        state._audioMuted = false;
        clearTimeout(state._audioMutedTimer);

        const isAck = payload.meta?.phase === "ack";
        const isResult = payload.meta?.phase === "result";
        const isSelection = payload.meta?.phase === "selection";
        const isSentence = payload.meta?.phase === "sentence";
        const isFinal = payload.meta?.phase === "final";
        const isTaskAck = payload.meta?.phase === "task-ack";

        if (
          !isSentence &&
          !isFinal &&
          !payload.audioBase64 &&
          !(payload.displayText || "").trim() &&
          !(payload.speechText || "").trim() &&
          !isAck
        ) {
          break;
        }

        let placeholderDedup = false;

        if (isSentence) {
          if (!state._streaming) {
            if (payload.meta?.intent === "image_understanding") {
              const placeholderIndex = state.conversation.findIndex(
                (item) => item.type === "agent" && item._placeholder
              );
              if (placeholderIndex >= 0) {
                state.conversation[placeholderIndex] = {
                  type: "agent",
                  route: payload.route || "veadk",
                  displayText: payload.displayText || "",
                  speechText: payload.speechText || "",
                  timing: null,
                  isAck: false,
                  mediaItems: payload.mediaItems || []
                };
                state._streaming = state.conversation[placeholderIndex];
                placeholderDedup = true;
              }
            }

            if (!placeholderDedup) {
              state.conversation.push({ type: "user", text: state.transcript || "(语音输入)" });
              state._streaming = {
                type: "agent",
                route: payload.route || "veadk",
                displayText: payload.displayText || "",
                speechText: payload.speechText || "",
                timing: null,
                isAck: false,
                mediaItems: payload.mediaItems || []
              };
              state.conversation.push(state._streaming);
            }
          } else {
            state._streaming.displayText += payload.displayText || "";
            state._streaming.speechText += payload.speechText || "";
            updateLastAgentBubble(state._streaming);
            playAssistantAudio(payload);
            break;
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
            state._streaming.mediaItems = payload.mediaItems || state._streaming.mediaItems;
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

        if (!isResult && !isSelection && !isTaskAck) {
          state.conversation.push({ type: "user", text: state.transcript || "(语音输入)" });
        }

        const hasAgentContent = payload.displayText || payload.speechText || payload.audioBase64 || payload.mediaItems?.length;
        if (hasAgentContent) {
          state.conversation.push({
            type: "agent",
            route: payload.route || "veadk",
            displayText: isAck ? `⏳ ${payload.displayText}` : payload.displayText || "",
            speechText: payload.speechText || "",
            timing: payload.timing || null,
            isAck,
            mediaItems: payload.mediaItems || []
          });
        }

        renderMessages();
        renderLatencyLog();
        playAssistantAudio(payload);

        if (isResult) {
          const lastUser = [...state.conversation].reverse().find((item) => item.type === "user");
          saveHistory({
            time: new Date().toLocaleString("zh-CN"),
            route: payload.route || "veadk",
            userText: lastUser?.text || "(语音输入)",
            displayText: payload.displayText || "",
            speechText: payload.speechText || "",
            timing: payload.timing || null
          });
        } else if (!isAck && !isSelection && !isTaskAck) {
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

        if (isAck) {
          state.transcript = "";
        }
        break;
      }
      case ServerEvent.ASSISTANT_TASK: {
        const existing = state.tasks.find((task) => task.taskId === payload.taskId);
        if (existing) {
          existing.status = payload.status;
          existing.detail = payload.detail;
        } else {
          state.tasks.unshift({
            _kind: "task",
            taskId: payload.taskId,
            sessionId: payload.sessionId,
            status: payload.status,
            title: payload.title,
            detail: payload.detail,
          });
        }
        const convEntry = state.conversation.find(
          (item) => item._kind === "task" && item.taskId === payload.taskId
        );
        if (convEntry) {
          convEntry.status = payload.status;
          convEntry.detail = payload.detail;
        } else {
          state.conversation.push({
            type: "task",
            _kind: "task",
            taskId: payload.taskId,
            sessionId: payload.sessionId,
            status: payload.status,
            title: payload.title,
            detail: payload.detail,
          });
        }
        renderMessages();
        if (payload.ttsBase64 && payload.ttsMimeType) {
          playAssistantAudio(payload);
        }
        break;
      }
      case ServerEvent.ASSISTANT_ERROR:
        state.conversation.push({ type: "error", message: payload.message });
        renderMessages();
        break;
      case ServerEvent.CAPTURE_PHOTO_REQUEST:
        handleCapturePhoto(payload.text);
        break;
      case ServerEvent.CAPTURE_VIDEO_REQUEST:
        startVideoRecording(payload.text).catch((error) => {
          state.conversation.push({ type: "error", message: `视频录制失败: ${error.message}` });
          renderMessages();
        });
        break;
      case ServerEvent.STOP_VIDEO_REQUEST:
        stopVideoRecording(true);
        break;
      case ServerEvent.MEDIA_PICK_REQUEST:
        state.albumSelectionRequest = payload;
        state.albumFilter = "video";
        openAlbum();
        renderAlbumModal();
        break;
      case ServerEvent.MEDIA_PICK_SELECT:
        handleVoiceVideoSelection(payload.selectionText);
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
      videoButton.disabled = true;
      stopMedia();
      renderStatus("连接已断开，正在重连…");

      // Attempt reconnection with exponential backoff
      const attempt = (state._reconnectAttempts || 0) + 1;
      state._reconnectAttempts = attempt;
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);

      clearTimeout(state._reconnectTimer);
      state._reconnectTimer = setTimeout(() => {
        if (!state.sessionActive) {
          handleStart().catch(() => {
            renderStatus("重连失败，请手动开始");
          });
        }
      }, delay);
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
  if (!payload.audioBase64 || !payload.audioMimeType || state._audioMuted) {
    return;
  }
  clearTimeout(state._audioMutedTimer);

  const binary = atob(payload.audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  try {
    const ctx = _getAudioCtx();
    const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
    state.audioQueue.push(audioBuffer);
    if (!state.audioPlaying) {
      _playAudioQueue(ctx);
    }
  } catch (error) {
    console.warn("[audio] decode failed:", error);
    enqueueAudioFallback(bytes, payload.audioMimeType);
  }
}

function enqueueAudioFallback(bytes, mimeType) {
  const blob = new Blob([bytes], { type: mimeType || "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  state.audioFallbackQueue.push(url);
  if (!state.audioFallbackPlaying) {
    void playAudioFallbackQueue();
  }
}

async function playAudioFallbackQueue() {
  const nextUrl = state.audioFallbackQueue.shift();
  if (!nextUrl) {
    state.audioFallbackPlaying = false;
    return;
  }

  state.audioFallbackPlaying = true;
  const audio = new Audio(nextUrl);
  audio.preload = "auto";
  state.activeAudio = audio;

  const cleanup = () => {
    URL.revokeObjectURL(nextUrl);
    if (state.activeAudio === audio) {
      state.activeAudio = null;
    }
  };

  audio.onended = () => {
    cleanup();
    void playAudioFallbackQueue();
  };
  audio.onerror = () => {
    cleanup();
    void playAudioFallbackQueue();
  };

  try {
    await audio.play();
  } catch (error) {
    console.warn("[audio] fallback play failed:", error);
    cleanup();
    void playAudioFallbackQueue();
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
  state.audioQueue = [];
  state.audioPlaying = false;
  state.audioNextPlayTime = 0;
  state.audioFallbackQueue.forEach((url) => URL.revokeObjectURL(url));
  state.audioFallbackQueue = [];
  state.audioFallbackPlaying = false;
  state._audioMuted = true;
  clearTimeout(state._audioMutedTimer);
  state._audioMutedTimer = setTimeout(() => {
    state._audioMuted = false;
  }, 3000);
  if (state.playbackAudioCtx) {
    state.playbackAudioCtx.close().catch(() => {});
    state.playbackAudioCtx = null;
  }
  state.activeAudio?.pause();
  state.activeAudio = null;
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
  if (sourceRate === 16000) return samples;
  const ratio = sourceRate / 16000;
  const newLength = Math.round(samples.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < samples.length; i += 1) {
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
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
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
  if (!state.pcmBufferSize) return;
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

  await audioContext.audioWorklet.addModule("/audio-processor.js");

  const sourceNode = audioContext.createMediaStreamSource(state.mediaStream);
  const workletNode = new AudioWorkletNode(audioContext, "downsample-processor", {
    processorOptions: { sampleRate: audioContext.sampleRate }
  });
  const gainNode = audioContext.createGain();
  gainNode.gain.value = 0;

  workletNode.port.onmessage = (event) => {
    if (!state.sessionActive) return;
    if (event.data.type === "audio") {
      const downsampled = new Float32Array(event.data.data);
      state.pcmBuffer.push(downsampled);
      state.pcmBufferSize += downsampled.length;
      if (state.pcmBuffer.length === 1 || state.pcmBufferSize >= 2400) {
        flushAudioChunk();
      }
    }
  };

  sourceNode.connect(workletNode);
  workletNode.connect(gainNode);
  gainNode.connect(audioContext.destination);

  state.audioContext = audioContext;
  state.sourceNode = sourceNode;
  state.processorNode = workletNode;
  state.gainNode = gainNode;
}

function stopMedia() {
  flushAudioChunk();
  stopVideoRecording(false);
  state.mediaStream?.getTracks().forEach((track) => track.stop());
  state.mediaStream = null;
  cameraPreview.srcObject = null;
  state.processorNode?.disconnect();
  state.gainNode?.disconnect();
  state.sourceNode?.disconnect();
  state.processorNode = null;
  state.gainNode = null;
  state.sourceNode = null;
  state.audioContext?.close().catch(() => {});
  state.audioContext = null;
  state.pcmBuffer = [];
  state.pcmBufferSize = 0;
  state.activeAudio?.pause();
  state.activeAudio = null;
}

async function handleStart() {
  await startMedia();
  try {
    await startAudioStreaming();
  } catch (error) {
    stopMedia();
    throw error;
  }
  send({
    type: ClientEvent.SESSION_START,
    sessionId,
    userId
  });
  state.sessionState = SessionState.LISTENING;
  startButton.disabled = true;
  stopButton.disabled = false;
  photoButton.disabled = false;
  videoButton.disabled = false;
  renderStatus("正在聆听…");
}

function handleStop() {
  state.sessionActive = false;
  state.sessionState = SessionState.IDLE;
  startButton.disabled = false;
  stopButton.disabled = true;
  photoButton.disabled = true;
  videoButton.disabled = true;
  stopMedia();
  renderStatus("对话已结束");
  send({
    type: ClientEvent.SESSION_STOP,
    sessionId
  });
}

async function storePhoto(blob, voiceText = "") {
  await persistMediaItem({
    id: crypto.randomUUID(),
    kind: "photo",
    blob,
    mimeType: blob.type || "image/jpeg",
    fileName: `photo-${Date.now()}.jpg`,
    createdAt: Date.now(),
    sourceText: voiceText
  });
}

async function handleCapturePhoto(voiceText = "") {
  if (!state.mediaStream) return;

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

  const blob = await new Promise((resolve) => captureCanvas.toBlob(resolve, "image/jpeg", 0.7));
  const dataUrl = captureCanvas.toDataURL("image/jpeg", 0.6);
  state.lastPhoto = dataUrl;
  await storePhoto(blob, voiceText);

  const userLabel = voiceText || "📷 拍照";
  state.conversation.push({ type: "user", text: userLabel });
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

function pickSupportedMimeType() {
  const candidates = [
    "video/mp4;codecs=avc1,mp4a",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  return candidates.find((value) => MediaRecorder.isTypeSupported(value)) || "";
}

async function startVideoRecording(voiceText = "") {
  if (!state.mediaStream) {
    throw new Error("媒体流未启动");
  }
  if (state.isRecordingVideo) {
    return;
  }
  if (!("MediaRecorder" in globalThis)) {
    throw new Error("当前浏览器不支持视频录制");
  }

  const mimeType = pickSupportedMimeType();
  state.videoChunks = [];
  state.currentRecordingLabel = voiceText || "🎬 录制视频";
  state.mediaRecorder = new MediaRecorder(state.mediaStream, mimeType ? { mimeType } : undefined);
  state.mediaRecorder.ondataavailable = (event) => {
    if (event.data?.size) {
      state.videoChunks.push(event.data);
    }
  };
  state.mediaRecorder.onstop = async () => {
    const durationMs = state.recordingStartedAt ? Date.now() - state.recordingStartedAt : null;
    const finalMimeType = state.mediaRecorder?.mimeType || mimeType || "video/mp4";
    const ext = finalMimeType.includes("mp4") ? "mp4" : finalMimeType.includes("webm") ? "webm" : "mp4";
    const blob = new Blob(state.videoChunks, { type: finalMimeType });
    state.videoChunks = [];
    state.mediaRecorder = null;
    state.isRecordingVideo = false;
    state.recordingStartedAt = 0;
    renderStatus("视频已保存到本地相册");

    if (blob.size > 0) {
      await persistMediaItem({
        id: crypto.randomUUID(),
        kind: "video",
        blob,
        mimeType: blob.type || "video/mp4",
        fileName: `video-${Date.now()}.${ext}`,
        createdAt: Date.now(),
        durationMs,
        sourceText: state.currentRecordingLabel
      });
      state.conversation.push({
        type: "agent",
        route: "gateway",
        displayText: "🎬 视频录制完成，已保存到本地相册。",
        speechText: "",
        timing: null,
        mediaItems: []
      });
      renderMessages();
    }
  };

  state.mediaRecorder.start(1000);
  state.isRecordingVideo = true;
  state.recordingStartedAt = Date.now();
  renderStatus("正在录制视频…");
}

function stopVideoRecording(shouldSave = true) {
  if (!state.isRecordingVideo || !state.mediaRecorder) {
    return;
  }
  if (!shouldSave) {
    state.mediaRecorder.onstop = null;
    state.mediaRecorder.stop();
    state.mediaRecorder = null;
    state.videoChunks = [];
    state.isRecordingVideo = false;
    state.recordingStartedAt = 0;
    renderStatus("录制已取消");
    return;
  }
  state.mediaRecorder.stop();
}

async function handleVoiceVideoSelection(selectionText) {
  if (!state.albumSelectionRequest) {
    return;
  }

  const videos = state.mediaItems.filter((item) => item.kind === "video");
  if (!videos.length) {
    state.conversation.push({ type: "error", message: "相册中没有找到视频。" });
    renderMessages();
    return;
  }

  const text = selectionText.trim();
  let matched = null;

  const ordinalMap = {
    "一": 0, "二": 1, "三": 2, "四": 3, "五": 4,
    "1": 0, "2": 1, "3": 2, "4": 3, "5": 4
  };

  const ordinalMatch = text.match(/第.?([一二三四五12345])/);
  if (ordinalMatch) {
    const idx = ordinalMap[ordinalMatch[1]];
    if (idx !== undefined && idx < videos.length) {
      matched = videos[idx];
    }
  }

  if (!matched) {
    const fileNameMatch = text.match(/([A-Za-z0-9_\-.]+\.(?:mp4|mov|webm|m4v))/i);
    if (fileNameMatch) {
      matched = videos.find((v) =>
        (v.fileName || "").toLowerCase().includes(fileNameMatch[1].toLowerCase())
      );
    }
  }

  if (!matched && /最新|最近|最后|刚/.test(text)) {
    matched = videos.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  }

  if (!matched && /最长/.test(text)) {
    matched = videos.reduce((a, b) => ((a.durationMs || 0) > (b.durationMs || 0) ? a : b));
  }

  if (!matched && /最短/.test(text)) {
    matched = videos.reduce((a, b) => ((a.durationMs || 0) < (b.durationMs || 0) ? a : b));
  }

  if (!matched && /这个|那个|选这个|选那个|就这个|就那个/.test(text)) {
    matched = videos[0];
  }

  if (!matched && videos.length === 1) {
    matched = videos[0];
  }

  if (!matched) {
    state.conversation.push({
      type: "error",
      message: `未能根据"${text}"匹配到视频，请手动选择。`
    });
    renderMessages();
    return;
  }

  closeAlbum(true);
  await submitSelectedVideoForEdit(matched);
}

async function submitSelectedVideoForEdit(item) {
  if (!state.albumSelectionRequest) {
    return;
  }

  const request = state.albumSelectionRequest;
  state.albumSelectionRequest = null;
  closeAlbum(true);

  state.conversation.push({
    type: "user",
    text: `🎬 已选择视频：${item.fileName || item.id}`
  });
  renderMessages();

  try {
    const response = await fetch(`${gatewayHttpBase}/api/videos/edit-source`, {
      method: "POST",
      headers: {
        "content-type": item.mimeType || "video/mp4",
        "x-session-id": sessionId,
        "x-user-id": userId,
        "x-original-text": encodeURIComponent(request.originalText || ""),
        "x-file-name": encodeURIComponent(item.fileName || "capture.mp4"),
        "x-asset-id": item.id,
        "x-request-id": request.requestId || ""
      },
      body: item.blob
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      console.error("[glasses-web] video edit upload failed:", payload.message || `HTTP ${response.status}`);
      throw new Error(payload.message || `HTTP ${response.status}`);
    }
  } catch (error) {
    console.error("[glasses-web] submitSelectedVideoForEdit error:", error.message);
    throw error;
  }
}

function registerEventHandlers() {
  startButton.addEventListener("click", () => {
    handleStart().catch((error) => {
      renderStatus(`启动失败: ${error.message}`);
    });
  });
  stopButton.addEventListener("click", handleStop);
  photoButton.addEventListener("click", () => {
    handleCapturePhoto().catch((error) => {
      state.conversation.push({ type: "error", message: `拍照失败: ${error.message}` });
      renderMessages();
    });
  });
  videoButton.addEventListener("click", async () => {
    try {
      if (state.isRecordingVideo) {
        stopVideoRecording(true);
      } else {
        await startVideoRecording();
      }
    } catch (error) {
      state.conversation.push({ type: "error", message: `视频录制失败: ${error.message}` });
      renderMessages();
    }
  });
}

async function init() {
  registerEventHandlers();
  await refreshMediaItems();
  renderStatus("待命中");
}

init().catch((error) => {
  state.conversation.push({ type: "error", message: `初始化失败: ${error.message}` });
  renderMessages();
  renderStatus("初始化失败");
});
