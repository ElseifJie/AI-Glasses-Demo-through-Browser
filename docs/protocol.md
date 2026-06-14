# Browser Gateway Protocol

Transport: WebSocket JSON messages.

## Client → Gateway

### `session.start`

```json
{
  "type": "session.start",
  "sessionId": "uuid",
  "userId": "uuid"
}
```

### `session.stop`

```json
{
  "type": "session.stop",
  "sessionId": "uuid"
}
```

### `transcript.user`

> **注意：** 此事件由网关在 ASR 回调后内部合成并入队（[server.mjs `enqueueTranscript()`](file:///Users/bytedance/Desktop/myProgram/AI Glasses Agent and ArkClaw/code/apps/gateway/src/server.mjs#L650)），**浏览器不直接发送**。浏览器仅发送 `audio.chunk` 音频流，ASR 识别完成后由网关自行构造 `transcript.user` 事件推入内部处理管线。烟雾测试中可通过 `source: "smoke-test"` 直接发送此事件以绕过 ASR。

```json
{
  "type": "transcript.user",
  "sessionId": "uuid",
  "userId": "uuid",
  "text": "帮我发飞书给张三，说十分钟后开会"
}
```

### `audio.chunk`

Sent by browser for streaming ASR.

```json
{
  "type": "audio.chunk",
  "sessionId": "uuid",
  "format": "pcm",
  "sampleRate": 16000,
  "audioBase64": "..."
}
```

### `photo.capture`

```json
{
  "type": "photo.capture",
  "sessionId": "uuid",
  "mimeType": "image/jpeg",
  "dataUrl": "data:image/jpeg;base64,..."
}
```

## Gateway → Client

### `session.state`

```json
{
  "type": "session.state",
  "sessionId": "uuid",
  "state": "listening",
  "message": "Microphone is active"
}
```

States: `idle`, `listening`, `thinking`, `delegating_to_arkclaw`, `speaking`

### `transcript.partial`

```json
{
  "type": "transcript.partial",
  "sessionId": "uuid",
  "text": "帮我发飞书..."
}
```

### `capture.photo.request`

Gateway requests browser to take a photo.

```json
{
  "type": "capture.photo.request",
  "sessionId": "uuid",
  "text": "拍照"
}
```

### `assistant.result`

Sent per sentence (phase: `sentence`) and once at end (phase: `final`).

```json
{
  "type": "assistant.result",
  "sessionId": "uuid",
  "route": "veadk",
  "speechText": "我已经整理好了重点。",
  "displayText": "完整回答显示在页面上。",
  "audioBase64": "...",
  "audioMimeType": "audio/mp3",
  "meta": {
    "intent": "general_chat",
    "phase": "sentence"
  },
  "timing": {
    "asrMs": 120,
    "agentMs": 800,
    "ttsMs": 500,
    "totalMs": 1420,
    "ttftMs": 920,
    "ttfaMs": 1420
  }
}
```

`phase` values:
- `ack` — ArkClaw comfort message (飞书确认)
- `sentence` — one sentence of streaming response
- `result` — ArkClaw final result
- `final` — VeADK stream complete
- `error` — error occurred

`timing` fields:
| 字段 | 含义 | 计算方式 |
|------|------|----------|
| `asrMs` | ASR 时延 | 第一段音频到达 → ASR 产出最终文本 |
| `agentMs` | Agent 时延 | 网关发出指令 → LLM 产出第一句文字 |
| `ttsMs` | TTS 时延 | TTS 收到第一个文本 → 完成所有合成 |
| `totalMs` | 端到端总时延 | 最后音频到达 → 接收完所有音频答复 |
| `ttftMs` | 文字首响时延 | 最后音频到达 → 前端显示第一个文字 |
| `ttfaMs` | 语音首响时延 | 最后音频到达 → 前端开始语音播报 |

> **注意：** ArkClaw 路由与 VeADK 路由的统计口径不同：
> - **VeADK 路径**：`ttftMs = tFirstSentenceAgent - t0`（LLM 产出首句文字时间），`ttfaMs = tFirstSentenceTts - t0`（TTS 产出首句音频时间）。
> - **ArkClaw 路径**：`ttftMs = tAck - t0`（ack 安抚语音完成时间），`ttfaMs = tTtsDone - t0`（最终结果语音可播报时间，即结果文案经 TTS 合成完成的时间）。ArkClaw 路径下不存在流式 LLM 句子，因此 `agentMs` 和 `ttsMs` 均为近似值。

首句拆分为两个事件：
1. 文字先行（`audioBase64: null`，含 `ttftMs`）
2. 音频后续（`displayText: ""`，含 `ttfaMs`）

### `assistant.task`

ArkClaw task status updates.

```json
{
  "type": "assistant.task",
  "sessionId": "uuid",
  "taskId": "uuid",
  "status": "running",
  "title": "ArkClaw 飞书任务",
  "detail": "正在将指令发送给 ArkClaw"
}
```

`status` values: `running`, `completed`, `blocked`, `failed`

### `assistant.error`

```json
{
  "type": "assistant.error",
  "sessionId": "uuid",
  "message": "Gateway could not reach the delegated service."
}
```

## Routing Rule v1

- `send_feishu_message` → ArkClaw
- `take_photo` → browser captures photo → VeADK vision
- `web_search` → VeADK with web search
- `general_chat` / `image_understanding` → VeADK
