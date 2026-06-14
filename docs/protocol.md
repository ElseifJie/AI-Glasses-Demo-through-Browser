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

Sent when ASR produces final recognized text.

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
  "audioBase64": "...",
  "audioMimeType": "audio/pcm"
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
    "ttfrMs": 1420
  }
}
```

`phase` values:
- `ack` — ArkClaw comfort message (飞书确认)
- `sentence` — one sentence of streaming response
- `result` — ArkClaw final result
- `final` — VeADK stream complete
- `error` — error occurred

`timing` is only present on the first sentence and on the final message.

### `assistant.task`

ArkClaw task status updates.

```json
{
  "type": "assistant.task",
  "sessionId": "uuid",
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
