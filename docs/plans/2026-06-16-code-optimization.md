# Code Optimization Implementation Plan

> Internal implementation plan for this repository. Keep tool-specific execution notes out of public-facing docs.

**Goal:** Fix critical bugs, improve robustness, and optimize performance across the AI Glasses monorepo (frontend, gateway, VeADK agent).

**Architecture:** Incremental fixes across 3 services — no architectural changes. Each task is independent and can be implemented in any order. Focus on high-priority bugs first, then medium-priority performance improvements.

**Tech Stack:** Vanilla JS (frontend), Node.js/Express/ws (gateway), Python/FastAPI/httpx (VeADK agent)

---

### Task 1: Fix `_audioMuted` Permanent Lock (HIGH)

**Files:**
- Modify: `apps/glasses-web/src/main.js:1004-1018`

**Problem:** `stopAllAudio()` sets `state._audioMuted = true` without any recovery mechanism. After user interrupts TTS playback by speaking, all subsequent TTS audio is permanently muted because `playAssistantAudio()` checks `state._audioMuted` at line 917 and returns early. The only recovery is at line 668 in `ASSISTANT_RESULT` handler, but that only fires when a new result arrives — if the user speaks and the result is an ArkClaw task or photo capture (which don't go through the normal result path), audio stays muted forever.

**Step 1: Add timeout-based auto-recovery to `stopAllAudio`**

In `stopAllAudio()`, after setting `state._audioMuted = true`, add a timeout that resets it after 3 seconds:

```javascript
function stopAllAudio() {
  state.audioQueue = [];
  state.audioPlaying = false;
  state.audioNextPlayTime = 0;
  state.audioFallbackQueue.forEach((url) => URL.revokeObjectURL(url));
  state.audioFallbackQueue = [];
  state.audioFallbackPlaying = false;
  state._audioMuted = true;
  // Auto-recover after 3s to prevent permanent mute
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
```

Also add `_audioMutedTimer: null` to the `state` object initialization (around line 90).

**Step 2: Verify the fix**

Run the dev server and test: start a conversation, speak while TTS is playing, then wait 3 seconds and verify the next TTS response plays audio.

---

### Task 2: Fix `handleStart` Resource Leak (HIGH)

**Files:**
- Modify: `apps/glasses-web/src/main.js:1144-1158`

**Problem:** `handleStart()` calls `startMedia()` then `startAudioStreaming()`. If `startAudioStreaming()` throws (e.g., AudioContext creation fails), the media stream from `startMedia()` is never released — camera stays on, mic stays active, but the session never starts properly.

**Step 1: Wrap in try/finally**

```javascript
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
```

---

### Task 3: Add Session TTL Cleanup (HIGH)

**Files:**
- Modify: `apps/gateway/src/server.mjs:1111-1167`

**Problem:** `createGatewaySession()` creates sessions in the `sessions` Map but there is no TTL-based cleanup. If a WebSocket disconnects without sending `SESSION_STOP` (e.g., network drop, browser crash), the session and its ASR connection leak forever.

**Step 1: Add a periodic cleanup interval**

Add after the `sessions` Map declaration (around line 165):

```javascript
const SESSION_MAX_IDLE_MS = 10 * 60 * 1000; // 10 minutes

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (session.closed) {
      sessions.delete(sessionId);
      continue;
    }
    const idleMs = now - Math.max(session.lastAudioChunkAt || 0, session.createdAt || 0);
    if (idleMs > SESSION_MAX_IDLE_MS) {
      console.log(`[gateway] cleaning up idle session ${sessionId}, idle=${idleMs}ms`);
      closeSession(sessionId).catch((err) =>
        console.warn(`[gateway] cleanup session ${sessionId} failed:`, err.message)
      );
    }
  }
}, 60_000);
```

**Step 2: Add `createdAt` to session object**

In `createGatewaySession()`, add `createdAt: Date.now()` to the session object:

```javascript
const session = {
  ws,
  userId: userId || "",
  state: SessionState.LISTENING,
  queue: [],
  processing: false,
  asrSession: null,
  closed: false,
  lastAudioChunkAt: 0,
  firstAudioChunkAt: 0,
  createdAt: Date.now(),
  pendingPhotoText: null,
  pendingVideoEdit: null,
  pendingArkClawFollowUp: null
};
```

---

### Task 4: State Machine Recovery After VeADK Errors (HIGH)

**Files:**
- Modify: `apps/gateway/src/server.mjs:1023-1048`

**Problem:** When `streamVeadkToClient()` throws (lines 1023-1048), the catch block sends an error result but does NOT transition the session state back to `LISTENING`. The session remains stuck in `THINKING` state (set at line 699). The subsequent `SPEAKING` → `LISTENING` transitions at lines 1050-1057 are after the try/catch, so they only run on success.

**Step 1: Add state transitions in the catch block**

```javascript
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
        asrMs: t1 - tAsrStart,
        agentMs: 0,
        ttsMs: 0,
        totalMs: Date.now() - t0
      }
    });
    send(
      ws,
      createSessionState(SessionState.SPEAKING, "Error response ready.", payload.sessionId)
    );
    send(
      ws,
      createSessionState(SessionState.LISTENING, "Waiting for the next utterance.", payload.sessionId)
    );
    return; // prevent the success-path state transitions below
  }
```

Note: The `return` is critical — without it, the success-path transitions at lines 1050-1057 would also fire, sending duplicate state messages.

---

### Task 5: ArkClaw Callback Race Condition (MEDIUM)

**Files:**
- Modify: `apps/gateway/src/server.mjs:890-1021`

**Problem:** In the `SEND_FEISHU_MESSAGE` handler, `delegateToArkClaw()` is called with `.then()` (fire-and-forget), and the comfort ack is sent immediately after. If the ArkClaw result comes back before the comfort ack TTS finishes, or if the session is closed between the ack and the result, the callback at line 906 checks `session.closed` but the comfort ack path at lines 987-1018 does not check whether the session is still valid before sending state transitions.

**Step 1: Add session validity check before comfort ack**

Wrap the comfort ack block (lines 987-1018) with a session check:

```javascript
    const sessionAfterDelegate = sessions.get(payload.sessionId);
    if (sessionAfterDelegate && !sessionAfterDelegate.closed && ws.readyState === WebSocket.OPEN) {
      const comfortText = await generateSpeechText(payload.text, taskLabel, "ack");
      const tTtsAckStart = Date.now();
      const comfortTts = await synthesizeSpeech(comfortText);
      tAck = Date.now();

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
          asrMs: t1 - tAsrStart,
          agentMs: 0,
          ttsMs: tAck - tTtsAckStart,
          totalMs: tAck - t0,
          ttftMs: tAck - t0,
          ttfaMs: tAck - t0
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
    }
```

---

### Task 6: Replace Deprecated ScriptProcessorNode with AudioWorklet (MEDIUM)

**Files:**
- Modify: `apps/glasses-web/src/main.js:1094-1122`
- Create: `apps/glasses-web/public/audio-processor.js`

**Problem:** `createScriptProcessor(4096, 1, 1)` is deprecated and runs on the main thread, causing UI jank during audio processing. AudioWorklet runs on a dedicated audio thread.

**Step 1: Create the AudioWorklet processor**

Create `apps/glasses-web/public/audio-processor.js`:

```javascript
class DownsampleProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;
    
    const channelData = input[0];
    // Downsample to 16kHz using simple averaging
    const sourceRate = sampleRate; // provided via processorOptions
    const ratio = sourceRate / 16000;
    const newLength = Math.round(channelData.length / ratio);
    const result = new Float32Array(newLength);
    
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < result.length) {
      const nextOffset = Math.round((offsetResult + 1) * ratio);
      let sum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffset && i < channelData.length; i++) {
        sum += channelData[i];
        count++;
      }
      result[offsetResult] = count > 0 ? sum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffset;
    }
    
    this.port.postMessage({ type: "audio", data: result.buffer }, [result.buffer]);
    return true;
  }
}

registerProcessor("downsample-processor", DownsampleProcessor);
```

**Step 2: Update `startAudioStreaming()` to use AudioWorklet**

```javascript
async function startAudioStreaming() {
  const audioContext = new AudioContext();
  await audioContext.resume();

  // Load AudioWorklet module
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
```

**Step 3: Update `stopMedia()` to handle worklet cleanup**

In `stopMedia()`, replace `state.processorNode?.disconnect()` with the worklet-compatible cleanup (the existing `.disconnect()` works for AudioWorkletNode too, so no change needed — just verify).

---

### Task 7: Optimize `renderMessages` to Avoid Full DOM Rebuild (MEDIUM)

**Files:**
- Modify: `apps/glasses-web/src/main.js:495-543`

**Problem:** `renderMessages()` does `messageList.innerHTML = ...` on every streaming update, rebuilding the entire DOM. During streaming, this fires on every sentence (potentially 5-10 times per response), causing layout thrashing.

**Step 1: Add a streaming message element reference and incremental update**

Add to state (around line 90):
```javascript
_streamingEl: null,
```

**Step 2: Modify the streaming update path**

In the `ASSISTANT_RESULT` handler, for `isSentence` phase (around line 690), instead of calling `renderMessages()` which rebuilds everything, update the streaming element directly:

```javascript
if (isSentence) {
  if (!state._streaming) {
    // ... existing placeholder logic ...
    state.conversation.push({ type: "user", text: state.transcript || "(语音输入)" });
    state._streaming = { /* ... */ };
    state.conversation.push(state._streaming);
    renderMessages(); // full render only for new message
  } else {
    state._streaming.displayText += payload.displayText || "";
    state._streaming.speechText += payload.speechText || "";
    // Incremental update: only update the last agent bubble
    updateLastAgentBubble(state._streaming);
  }
  playAssistantAudio(payload);
  break;
}
```

**Step 3: Add `updateLastAgentBubble` helper**

```javascript
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
```

---

### Task 8: Clean Up Blob URL Accumulation (LOW)

**Files:**
- Modify: `apps/glasses-web/src/main.js:239-254`

**Problem:** `getPreviewUrl()` creates blob URLs via `URL.createObjectURL()` and stores them in `state.mediaPreviewUrls` Map. These are only revoked when an item is explicitly deleted. Over time, as the album modal is opened/closed repeatedly, blob URLs accumulate and consume memory.

**Step 1: Revoke URLs when album modal closes**

In `closeAlbum()` (around line 349), add cleanup:

```javascript
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
```

---

### Task 9: Add Frontend WebSocket Reconnection (LOW)

**Files:**
- Modify: `apps/glasses-web/src/main.js:629-893`

**Problem:** When the WebSocket disconnects (line 878), the frontend resets state but never attempts to reconnect. The user must manually click "开始对话" again.

**Step 1: Add reconnection logic to the `close` handler**

Add to state (around line 90):
```javascript
_reconnectAttempts: 0,
_reconnectTimer: null,
```

**Step 2: Modify the `close` event handler**

```javascript
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
    
    // Attempt reconnection with backoff
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
```

**Step 3: Reset reconnection state on successful connection**

In the `SESSION_STATE` handler where `state.sessionActive` is set to true (line 643), add:
```javascript
state._reconnectAttempts = 0;
clearTimeout(state._reconnectTimer);
```

---

### Task 10: Profile Update Debounce (LOW)

**Files:**
- Modify: `apps/veadk-agent/app.py:247-252, 324-377`

**Problem:** `_schedule_profile_update()` creates a new asyncio task for every user message. If a user sends 10 messages rapidly, 10 profile update tasks run concurrently, each doing a full LLM call and full file write. This wastes API calls and causes file write contention.

**Step 1: Add debounce with a per-user lock and timer**

Add to `OpenAICompatibleClient.__init__()`:
```python
self._profile_locks: dict[str, asyncio.Lock] = {}
self._profile_timers: dict[str, asyncio.Task[None]] = {}
```

**Step 2: Modify `_schedule_profile_update`**

```python
def _schedule_profile_update(self, user_id: str, user_text: str) -> None:
    if not user_id or not user_text:
        return
    
    # Cancel any pending update for this user
    existing = self._profile_timers.get(user_id)
    if existing and not existing.done():
        existing.cancel()
    
    # Debounce: wait 5 seconds before actually updating
    async def _debounced():
        try:
            await asyncio.sleep(5)
            await self._update_profile(user_id, user_text)
        except asyncio.CancelledError:
            pass
    
    task = asyncio.create_task(_debounced())
    self._profile_timers[user_id] = task
    task.add_done_callback(lambda t: self._profile_timers.pop(user_id, None))
```

---

## Execution Order

Recommended order (each task is independent):

1. **Task 1** — `_audioMuted` fix (highest user impact)
2. **Task 2** — `handleStart` resource leak
3. **Task 3** — Session TTL cleanup
4. **Task 4** — State machine recovery
5. **Task 5** — ArkClaw race condition
6. **Task 6** — AudioWorklet migration
7. **Task 7** — DOM render optimization
8. **Task 8** — Blob URL cleanup
9. **Task 9** — WebSocket reconnection
10. **Task 10** — Profile update debounce

## Verification

After all tasks are implemented, run:
```bash
cd <repo-root>
bash scripts/dev.sh start
node scripts/smoke-test.mjs
```
