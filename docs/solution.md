# AI Glasses Agent & ArkClaw — 技术方案文档

## 一、方案概述

### 1.1 项目定位

AI Glasses Agent 是一个**浏览器端 AI 智能眼镜 Demo**，模拟智能眼镜的核心交互体验：用户通过语音输入，系统经过语音识别（ASR）、意图路由、大模型对话/视觉理解、语音合成（TTS）后，以语音 + 文本的方式返回结果。

### 1.2 核心功能

| 功能 | 触发方式 | 路由目标 | 模型 |
|------|----------|----------|------|
| 闲聊对话 | 语音输入（默认） | VeADK Agent | doubao-1-5-lite-32k-250115 |
| 联网搜索 | 说"搜索/天气/查一下" | VeADK Agent + 火山引擎搜索 | doubao-1-5-lite-32k-250115 + Web Search API |
| 拍照识图 | 说"拍照/这是什么/眼前" 或点击拍照按钮 | VeADK Agent | doubao-seed-2-0-mini-260428 |
| 飞书操作 | 说"发消息/查看日程/创建文档" | ArkClaw 终端 | ArkClaw Gateway |

### 1.3 操作指导

```bash
# 1. 配置环境变量
cp .env.example .env
# 编辑 .env，填入必填的 API Key

# 2. 一键启动全部服务
npm run dev:start

# 3. 打开浏览器
# http://localhost:5173

# 4. 点击「开始对话」，授予麦克风和摄像头权限

# 5. 开始语音交互
```

其他命令：
```bash
npm run dev:stop    # 关闭全部服务
npm run dev:status  # 查看服务状态
npm run dev:logs    # 查看日志
npm run test:smoke  # 烟雾测试
```

---

## 二、技术架构

### 2.1 整体拓扑

```
┌─────────────────────────────────────────────────────────────┐
│                     浏览器 (glasses-web :5173)               │
│  ┌──────────┐  ┌───────────┐  ┌─────────┐  ┌───────────┐  │
│  │ 麦克风采集 │  │ 摄像头预览  │  │ 音频播放  │  │   UI 渲染  │  │
│  │ PCM 16kHz │  │ JPEG 640px │  │ MP3 解码  │  │ 时延诊断   │  │
│  └─────┬─────┘  └─────┬─────┘  └─────▲────┘  └─────▲─────┘  │
│        │              │              │              │         │
│        └──────────────┴──────────────┴──────────────┘         │
│                            │ WebSocket (JSON)                 │
└────────────────────────────┼─────────────────────────────────┘
                             │
┌────────────────────────────┼─────────────────────────────────┐
│                  网关 (gateway :8787)                          │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  会话管理 · 意图路由 · 时延打点 · 音频流分发            │    │
│  └──┬──────────┬──────────┬────────────┬────────────────┘    │
│     │   ASR    │   TTS    │  ArkClaw   │  VeADK Agent        │
│     │ 火山引擎  │ 火山引擎  │  终端      │  HTTP/SSE           │
│     │ WebSocket│ WebSocket│  WebSocket │                     │
│     │ 双向流式  │ 单向流式  │            │                     │
└─────┼──────────┼──────────┼────────────┼─────────────────────┘
      │          │          │            │
      ▼          ▼          ▼            ▼
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────────┐
│  Volc ASR │ │  Volc TTS│ │ ArkClaw  │ │  VeADK Agent (:9001) │
│  bigmodel │ │ seed-tts │ │ Gateway  │ │  FastAPI + SSE        │
│  16k PCM  │ │ 24k MP3  │ │          │ │  doubao LLM/VLM       │
└──────────┘ └──────────┘ └──────────┘ └──────────────────────┘
```

### 2.2 逻辑架构

```
┌──────────────────────────────────────────────────┐
│                   glasses-web                     │
│                                                   │
│  ┌─────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │ session │  │ audio    │  │ ui               │ │
│  │ manager │  │ pipeline │  │ - messages        │ │
│  │ - start │  │ - capture│  │ - latency log     │ │
│  │ - stop  │  │ - downsample│ - history       │ │
│  │ - state │  │ - chunk  │  │ - photo capture  │ │
│  └────┬────┘  │ - base64 │  │ - audio playback │ │
│       │       │ - send   │  │                  │ │
│       │       └────┬─────┘  └────────┬─────────┘ │
│       │            │                │            │
│       └────────────┴────────────────┘            │
│                     │ WS                          │
└─────────────────────┼────────────────────────────┘
                      │
┌─────────────────────┼────────────────────────────┐
│                     ▼                   gateway  │
│  ┌─────────────────────────────────────────────┐ │
│  │           session (Map<id, session>)         │ │
│  │  - ws, userId, state, queue, processing      │ │
│  │  - asrSession, lastAudioChunkAt, closed     │ │
│  └─────────────────────────────────────────────┘ │
│                                                   │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐ │
│  │ ASR Hub  │ │Intent    │ │  streamVeadkToClient│ │
│  │ - stream │ │Router    │ │  - SSE parse        │ │
│  │ - chunk  │ │- regex   │ │  - pipeline TTS     │ │
│  │ - trans- │ │- feishu  │ │  - timing track     │ │
│  │   cript  │ │- photo   │ └───────────────────┘ │
│  └──────────┘ │- search  │                        │
│               │- chat    │                        │
│               └──────────┘                        │
└───────────────────────────────────────────────────┘
```

### 2.3 状态机

```
                    SESSION_START
  IDLE ────────────────────────────────► LISTENING
    ▲                                       │
    │                          TRANSCRIPT_USER (utterance)
    │                                       │
    │                          ┌────────────┴─────────────┐
    │                          ▼                          ▼
    │                     THINKING               DELEGATING (ArkClaw)
    │                       VeADK                       │
    │                          │                   ┌────┴────┐
    │                     ┌────┴────┐             ▼         ▼
    │                     ▼         ▼         SPEAKING   SPEAKING
    │                 SPEAKING   SPEAKING    (comfort)  (result)
    │                     │         │            │         │
    │                     └────┬────┘            └────┬────┘
    │                          ▼                     ▼
    └──────────────────── LISTENING ◄─────────────────┘
                          SESSION_STOP → IDLE
```

### 2.4 时序图

```
浏览器              网关                   ASR                VeADK Agent          TTS
  │                  │                      │                    │                  │
  │ audio.chunk ────►│                      │                    │                  │
  │ (连续发送)        ├─────────────────────►│                    │                  │
  │                  │  writeAudio()         │                    │                  │
  │                  │                      │ onPartial(text)    │                  │
  │ ◄────────────────┤ transcript.partial   │                    │                  │
  │                  │                      │                    │                  │
  │                  │                      │ onUtterance(text)  │                  │
  │                  │ enqueueTranscript()   │                    │                  │
  │                  │ lastAudioChunkAt = t0 │                    │                  │
  │                  │ receivedAt = t1       │                    │                  │
  │                  │                      │                    │                  │
  │                  │ handleUserTranscript()│                    │                  │
  │                  │ intent = detectIntent │                    │                  │
  │                  │                      │                    │                  │
  │                  │ callVeadkStream() ───────────────────────►│                  │
  │                  │                      │                    │ SSE: sentence 1  │
  │                  │ tFirstSentenceAgent   │                    │                  │
  │ ◄────────────────┤ ASSISTANT_RESULT      │                    │                  │
  │  displayText     │ (sent.1, 文字先行      │                    │                  │
  │  audioBase64=N/A │  timing: ttftMs)       │                    │                  │
  │                  │                      │                    │                  │
  │                  │ synthesizeSpeech() ──────────────────────────────────────────►│
  │                  │ tFirstSentenceTts     │                    │                  │
  │ ◄────────────────┤ ASSISTANT_RESULT      │                    │                  │
  │  audioBase64     │ (sent.1, 音频后续      │                    │                  │
  │  ├─ 解码 MP3 ────┤  timing: ttfaMs)       │                    │                  │
  │  └─ 播放 ────────┤                      │                    │                  │
  │                  │                      │                    │ SSE: sentence 2  │
  │                  │ synthesizeSpeech() ──────────────────────────────────────────►│
  │ ◄────────────────┤ ASSISTANT_RESULT      │                    │                  │
  │  (sent.2, 无 timing)                    │                    │                  │
  │                  │                      │                    │ ...              │
  │                  │                      │                    │ SSE: DONE        │
  │ ◄────────────────┤ ASSISTANT_RESULT      │                    │                  │
  │  (phase: final,   │                      │                    │                  │
  │   summary timing) │                      │                    │                  │
```

**关键时间戳：**
- `tAsrStart` = `session.firstAudioChunkAt` — 第一段音频到达网关的时间
- `t0` = `session.lastAudioChunkAt` — 最后一段音频到达网关的时间
- `t1` = `payload.receivedAt` — ASR 产出最终识别文本的时间
- `tAgentStart` — 网关开始调用 VeADK 的时间
- `tFirstSentenceAgent` — VeADK 返回第一个完整句子的时间
- `tFirstSentenceTts` — TTS 返回第一个句子音频的时间
- `tTtsFirst` — TTS 开始合成第一个句子的时间
- `tTtsLast` — TTS 完成最后一个句子合成的时间
- `asrMs = t1 - tAsrStart` — ASR 从第一段音频到产出文本的总耗时
- `agentMs = tFirstSentenceAgent - tAgentStart` — 网关发出指令到 LLM 产出第一句文字
- `ttsMs = tTtsLast - tTtsFirst` — TTS 从第一个文本到完成所有合成
- `ttftMs = tFirstSentenceAgent - t0` — 文字首响时延（Time To First Text）
- `ttfaMs = tFirstSentenceTts - t0` — 语音首响时延（Time To First Audio）
- `totalMs = tTtsLast - t0` — 端到端总时延

> **注意：** 以上公式适用于 VeADK 默认路由。ArkClaw 路由下不存在流式 LLM 句子，`ttftMs` 改为 ack 安抚语音完成时间（`tAck - t0`），`ttfaMs` 改为结果语音可播报时间（`tTtsDone - t0`，即结果文案经 TTS 合成完成的时间），`agentMs` 和 `ttsMs` 均为近似值。

---

## 三、关键技术细节

### 3.1 音频采集与处理

| 参数 | 值 | 说明 |
|------|-----|------|
| 浏览器采集格式 | PCM Float32, 单声道 | `getUserMedia({ audio: true })` 原生格式 |
| 采样率（最终） | **16,000 Hz** | 火山引擎 ASR 标准输入 |
| 位深度 | **16-bit** | 从 Float32 转 Int16（`floatTo16BitPcm()`） |
| 声道 | **1（单声道）** | |
| 降采样算法 | 均值法 | `downsampleTo16k()`：按源采样率/16000 的比例取平均 |
| 采集缓冲 | `ScriptProcessorNode(4096, 1, 1)` | 回调缓冲区大小 4096 samples |
| 发送触发条件 | 首次或累积 ≥ **2,400 samples** | 约 150ms 音频，平衡延迟与吞吐 |
| 编码方式 | **Base64** 字符串 | 通过 WebSocket JSON 传输 |
| 消息格式 | `{ type: "audio.chunk", audioBase64, format: "pcm", sampleRate: 16000 }` | |

#### 降采样算法伪代码

```
function downsampleTo16k(samples, sourceRate):
    ratio = sourceRate / 16000
    newLength = round(samples.length / ratio)
    result = new Float32Array(newLength)
    for i in 0..newLength:
        start = round(i * ratio)
        end = round((i+1) * ratio)
        result[i] = average(samples[start..end])
    return result
```

### 3.2 ASR（语音识别）

| 参数 | 值 | 说明 |
|------|-----|------|
| 服务 | 火山引擎 ASR | `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel` |
| 协议 | **自定义二进制 + WebSocket** | 4 字节 Header + 4 字节 Length + Payload |
| 模型 | **bigmodel** | 火山引擎大模型 |
| 音频格式 | **PCM 16-bit 16kHz 单声道** | |
| WebSocket Header | `X-Api-App-Key`, `X-Api-Access-Key`, `X-Api-Resource-Id`, `X-Api-Connect-Id` | 鉴权 + 会话关联 |
| 分片大小 | **6,400 bytes**（PCM） / 4,096 bytes（其他） | `chunkPcm()` 函数 |
| 部分结果回调 | `onPartial(text)` | 实时发送 `transcript.partial` 到前端 |
| 完整句子回调 | `onUtterance(text)` | 入队 `enqueueTranscript()` |
| VAD 尾窗 | **800ms** | `end_window_size: 800` |
| ITN | **启用** | 逆文本归一化（数字、日期等） |
| 标点 | **启用** | 自动添加标点 |

#### 二进制协议帧格式（Header）

```
┌──────┬──────────────┬─────────────────┬──────────┐
│Byte 0│   Byte 1     │    Byte 2       │  Byte 3  │
│ 0x11 │ msg_type(4b) │ serial(4b)│comp │ reserved │
│      │  │ flags(4b) │    │     │ (4b)  │   0x00   │
└──────┴──────────────┴─────────────────┴──────────┘
```

消息类型（4 位高）：
- `0x1` = FULL_CLIENT_REQUEST（JSON 控制帧）
- `0x2` = AUDIO_ONLY_REQUEST（音频帧）
- `0x9` = FULL_SERVER_RESPONSE（服务端响应）
- `0xF` = ERROR

Flags（4 位低）：
- `0x0` = NONE
- `0x1` = POSITIVE_SEQUENCE（含序列号）
- `0x2` = FINAL_PACKET（最后一帧）

序列化（4 位高）：
- `0x0` = NONE（原始 PCM）
- `0x1` = JSON

压缩（4 位低）：
- `0x0` = NONE
- `0x1` = GZIP

### 3.3 TTS（语音合成）

| 参数 | 值 | 说明 |
|------|-----|------|
| 服务 | 火山引擎 TTS | `wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream` |
| 模型 | **seed-tts-2.0** | |
| 输出格式 | **MP3** | 高压缩比，适合网络传输 |
| 采样率 | **24,000 Hz** | MP3 输出 |
| 语速 | **1.0**（正常） | 可通过 `speech_rate` 调整 |
| 音色 | **zh_female_vv_uranus_bigtts** | 中文女声 |
| 合成超时 | **8,000 ms** | 单句合成超时 |
| 连接池 | 单连接复用 + 请求队列 | `_processQueue()` 串行处理 |
| 请求 Header | `X-Api-App-Id`, `X-Api-Access-Key`, `X-Api-Resource-Id`, `X-Api-Request-Id` | |
| 二进制协议 | 同 ASR 的 Header 格式 | 事件帧含 eventCode + sessionId |

#### TTS 事件码

| Code | 含义 |
|------|------|
| `350` | TTS_SENTENCE_START |
| `351` | TTS_SENTENCE_END |
| `352` | TTS_RESPONSE（音频数据） |
| `152` | SESSION_FINISHED（合成完成） |

### 3.4 图片采集与编码

| 参数 | 值 | 说明 |
|------|-----|------|
| 采集方式 | `<canvas>` 绘制 `<video>` | 从摄像头预览流截帧 |
| 编码格式 | **JPEG** | |
| 压缩质量 | **0.6** | `toDataURL("image/jpeg", 0.6)` |
| 最大分辨率 | **640px**（长边） | `MAX_IMAGE_DIM = 640`，等比缩放 |
| 传输方式 | **Base64 Data URL** | `data:image/jpeg;base64,...` |
| 消息格式 | `{ type: "photo.capture", dataUrl, mimeType: "image/jpeg", text }` | |
| 视觉模型 | **doubao-seed-2-0-mini-260428** | 多模态 VLM |

### 3.5 意图识别

| 参数 | 值 | 说明 |
|------|-----|------|
| 算法 | **正则表达式匹配** | 67 条模式，优先级顺序匹配 |
| 优先级 | 1. 飞书 → 2. 拍照 → 3. 搜索 → 4. 闲聊 | |
| 飞书模式数 | 17 条 | 中文 + 英文 |
| 拍照模式数 | 32 条 | 中文 + 英文，含手持/眼前/观察/辨认 |
| 搜索模式数 | 18 条 | |
| 图片触发 | `hasImage = true` → 直接路由到 `image_understanding` | |

#### 拍照意图模式（核心示例）

```
/拍照/     /这是什么/   /眼前.*什么/   /手上.*什么/
/拿着.*什么/ /帮我看看/   /看看这/       /瞧瞧/
/认得/     /认识/       /识别一下/     /what.*(this|that)/i
/what.*(am i|are we).*(looking|seeing|holding)/i
```

### 3.6 大模型调用

| 参数 | 聊天 | 搜索 | 视觉 |
|------|------|------|------|
| 模型 | doubao-1-5-lite-32k-250115 | 同左 | doubao-seed-2-0-mini-260428 |
| API | OpenAI Chat Completions | 同左 | 同左 |
| 模式 | **SSE Streaming** | SSE Streaming | SSE Streaming |
| 温度 | 0.3 | 0.3 | 0.3 |
| max_tokens | 256（流式）/ 1024（非流式） | 256 | 256 |
| 句分割符 | `。！？\n\n` | 同左 | 同左 |
| 历史轮次 | 3 轮（6 条消息） | 同左 | 同左 |
| 系统提示词 | DEFAULT_PROMPT_CHAT | DEFAULT_PROMPT_SEARCH | DEFAULT_PROMPT_VISION |
| 回复格式 | DEFAULT_REPLY_FORMAT | 同左 | 同左 |

> 提示词均已硬编码在 `app.py` 中，不再通过 `.env` 环境变量配置。

#### 句子分割算法

```
LLM 输出流 → 累积到 buffer
→ 检测 buffer 是否以句分割符结尾（。！？\n\n）
→ 是：yield buffer（一个完整句子）
→ 否：继续累积
→ 流结束时 yield 剩余 buffer
```

#### TTS 播报文本策略

VeADK 和 ArkClaw 采用不同的语音播报策略：

| 路由 | 策略 | 说明 |
|------|------|------|
| VeADK | 直连 TTS | 句子级直接 TTS 播报，无需 LLM 总结，降低时延 |
| ArkClaw ACK | LLM 总结 | 调用 veadk-agent `/speech`（`context: "ack"`），生成安抚语音，明确表达"稍等，完成后通知你" |
| ArkClaw Result | LLM 总结 | 调用 `/speech`（`context: "result"`），将任务结果提炼为简短语音播报 |

### 3.7 用户画像

| 参数 | 值 | 说明 |
|------|-----|------|
| 存储方式 | JSON 文件 | `memory_store.json`，按 userId 分组 |
| 更新方式 | 异步任务 | `asyncio.create_task`，非阻塞 |
| 模型 | doubao-1-5-lite-32k-250115 | 温度 0（精确提取） |
| 触发条件 | 每次对话后 | 无论意图类型 |
| 字段策略 | 动态 key | 无固定字段限制 |
| 记忆上限 | 20 条 | `memories` 数组保留最近 20 条 |

### 3.8 ArkClaw 终端对接

| 参数 | 值 | 说明 |
|------|-----|------|
| 协议 | WebSocket | ArkClaw Device Gateway |
| 认证 | Ed25519 签名 + Device Token | NaCl tweetnacl |
| 协议版本 | v3 | `buildDeviceAuthPayloadV3()` |
| 角色 | `operator` | read + write 权限 |
| 状态探测 | NEEDS_INPUT_PATTERNS | 检测是否需要用户确认 |
| Comfort Ack | 同步发送确认语音 | "收到，正在通过飞书帮你处理" |

### 3.9 前端音频播放

| 参数 | 值 | 说明 |
|------|-----|------|
| API | **Web Audio API** | AudioContext + decodeAudioData |
| 格式 | **MP3**（base64 → ArrayBuffer） | |
| 播放策略 | **队列顺序播放** | `audioQueue` + `onended` 链式调度 |
| 队列调度 | `Math.max(now, nextPlayTime)` | 避免句间重叠 |
| 打断机制 | `stopAllAudio()` | 清空队列 + 关闭 AudioContext + 设置 `_audioMuted` |
| 打断触发 | 收到 `transcript.partial` | 用户说话时立即停止播放 |

### 3.10 通信协议

#### WebSocket 协议（浏览器 ↔ 网关）

**客户端 → 网关：**

| 事件 | 说明 |
|------|------|
| `session.start` | 开启会话，携带 sessionId + userId |
| `session.stop` | 结束会话 |
| `audio.chunk` | 音频块，`audioBase64` + `format: "pcm"` + `sampleRate: 16000` |
| `transcript.user` | 文字输入（网关内部合成，浏览器主流程不直接发送） |
| `photo.capture` | 拍照，`dataUrl` + `mimeType: "image/jpeg"` |

**网关 → 客户端：**

| 事件 | 说明 |
|------|------|
| `session.state` | 状态变化，state ∈ {idle, listening, thinking, delegating_to_arkclaw, speaking} |
| `transcript.partial` | ASR 实时部分结果 |
| `assistant.result` | 助手回复，含 `phase ∈ {ack, sentence, result, final, error}` |
| `assistant.task` | ArkClaw 任务状态 |
| `assistant.error` | 错误信息 |
| `capture.photo.request` | 请求浏览器拍照（语音触发） |

#### SSE 协议（网关 ↔ VeADK Agent）

```
POST /chat/stream
Content-Type: application/json

响应：
Content-Type: text/event-stream

data: {"speechText": "你好！", "displayText": "你好！有什么可以帮助你的？"}

data: {"speechText": "...", "displayText": "...", "final": true}

data: [DONE]
```

### 3.11 时延指标体系

| 指标 | 计算方式 | 含义 |
|------|----------|------|
| **ASR 时延** | `t1 - tAsrStart` | 第一段音频到达 → ASR 产出最终文本 |
| **Agent 时延** | `tFirstSentenceAgent - tAgentStart` | 网关发出指令 → LLM 产出第一句文字 |
| **TTS 时延** | `tTtsLast - tTtsFirst` | TTS 收到第一个文本 → 完成所有合成 |
| **TTFT（文字首响）** | `tFirstSentenceAgent - t0` | 最后音频到达 → 前端显示第一个文字 |
| **TTFA（语音首响）** | `tFirstSentenceTts - t0` | 最后音频到达 → 前端开始语音播报 |
| **端到端总计** | `tTtsLast - t0` | 最后音频到达 → 接收完所有音频答复 |

前端展示的颜色编码：
- 🟢 绿色：< 500ms
- 🟡 黄色：500ms ~ 1500ms
- 🔴 红色：> 1500ms

---

## 四、关键优化记录

### 4.1 流水线化 TTS 发送

**问题：** 原始方案先收集 VeADK 返回的全部句子，再批量 TTS，最后逐句发送到前端。这导致用户必须等 LLM 完全生成完毕 + 全部 TTS 合成完毕才能听到第一句话，首响时延（TTFR）极高。

**原始流程：**
```
收集全部句子 → 批量 TTS（全部） → 逐句发送
                ↑ TTFR 包含完整 LLM + TTS 时间
```

**优化方案：** 将收集和发送合并为单循环，每收到一个完整句子就立即 TTS 合成并发送。首句拆分为文字先行、音频后续两个事件，精确测量文字首响（ttftMs）和语音首响（ttfaMs）：

```javascript
for await (const sentence of callVeadkStream(payload)) {
  if (sentence.final) { allDisplayText = sentence.displayText; continue; }
  if (!sentence.speechText && !sentence.displayText) continue;

  sentenceCount++;

  if (sentenceCount === 1) {
    tFirstSentenceAgent = Date.now();

    // 文字先行（无音频）
    send(ws, { displayText: sentence.displayText, audioBase64: null, timing: { ttftMs } });

    // 音频后续（无文字）
    const tts = await synthesizeSpeech(sentence.speechText);
    tFirstSentenceTts = Date.now();
    send(ws, { speechText: sentence.speechText, audioBase64: tts.audioBase64, timing: { ttfaMs } });
  } else {
    const tts = await synthesizeSpeech(sentence.speechText);
    send(ws, { speechText: sentence.speechText, displayText: sentence.displayText, audioBase64: tts.audioBase64 });
  }
}
```

**优化效果：** 文字首响（ttftMs）仅包含 LLM 首句生成时间，不等待 TTS，用户看到文字的速度大幅提升。

### 4.2 音频打断机制

**问题：** 原始方案不支持打断 —— 一旦 TTS 开始播放，用户只能等待播放完毕才能说下一句话，不符合自然对话体验。

**优化方案：** 实现"只停音频，不停任务"的半双工打断：

```
用户说话 → 前端 detect transcript.partial
         → stopAllAudio() (清空音频队列 + 关闭 AudioContext + 设置 _audioMuted)
         → 后端任务继续执行，文本继续显示
         → 新任务开始后自动解除 _audioMuted
```

**关键代码：**
```javascript
case ServerEvent.TRANSCRIPT_PARTIAL:
  if (state.audioPlaying) {
    stopAllAudio();  // 仅前端停止播放
  }
  break;
```

```javascript
function stopAllAudio() {
  state.audioQueue = [];
  state.audioPlaying = false;
  state._audioMuted = true;
  state.playbackAudioCtx?.close();
  state.playbackAudioCtx = null;
}
```

**效果：** 用户可以随时打断音频播放，过渡到下一轮对话，无需等待当前语音播放完毕。

### 4.3 ASR 耗时校准

**问题：** 原 `asrMs` 在 `handleUserTranscript` 内部取值，实际测量的是意图识别耗时（~0-5ms），导致前端几乎总是显示 "ASR 0ms"。

**根因分析：**
```
原 t0 = Date.now()  ────►  原 t1 = Date.now()
     ↑ handleUserTranscript 入口      ↑ 意图识别完成
     └── asrMs = 0~5ms（无意义）──────┘
```

**优化方案：** 在会话对象中记录 `lastAudioChunkAt`，端到端贯穿时间戳：

| 环节 | 时间戳 | 含义 |
|------|--------|------|
| AUDIO_CHUNK handler | `session.lastAudioChunkAt = Date.now()` | 最后一段音频到达时间 |
| enqueueTranscript | `receivedAt = Date.now()` | ASR 产出最终文本的时间 |
| | `asrAudioEndAt = session.lastAudioChunkAt` | 带入队列 |
| handleUserTranscript | `t0 = payload.asrAudioEndAt` | 最后音频到达 |
| | `t1 = payload.receivedAt` | ASR 文本就绪 |

**效果：** `asrMs = t1 - tAsrStart` 精确反映火山引擎 ASR 从第一段音频到产出最终文本的真实耗时（通常 200-1500ms）。

### 4.4 拍照意图增强

**问题：** 原拍照意图仅匹配"拍照"、"这是什么"、"眼前"等少数关键词，"我手上拿着的什么"、"帮我看看这个"等自然表达无法触发拍照。

**优化方案：** 将 `PHOTO_PATTERNS` 从 14 条扩展到 30 条（当前版本已进一步增至 32 条），覆盖三类场景：

| 类别 | 新增模式 | 匹配示例 |
|------|----------|----------|
| 手持/眼前 | `/手上.*什么/`, `/拿着.*什么/`, `/手里.*什么/`, `/面前.*什么/`, `/桌上.*什么/`, `/看见.*什么/`, `/那是什么/` | "我手上拿着的什么" |
| 观察/辨认 | `/帮我看看/`, `/看看这/`, `/瞧瞧/`, `/认得/`, `/认识/`, `/识别一下/` | "帮我看看这个" |
| 英文 | `/what.*(this\|that)/i`, `/what.*(am i\|are we).*(looking\|seeing\|holding)/i`, `/identify/i`, `/recognize/i` | "What am I looking at" |

### 4.5 ArkClaw Comfort Ack

**问题：** ArkClaw 飞书任务耗时较长（5-30s），用户发出指令后长时间无反馈。

**优化方案：** 在 ArkClaw 任务异步执行的同时，同步返回一条 LLM 生成的安抚语音，明确告知用户"稍等，完成后通知你"：

```javascript
// 异步启动 ArkClaw 任务（不 await）
delegateToArkClaw({ ...payload, intent }, ws).then(async (result) => { ... });

// 同步返回 comfort ack（LLM 总结 + TTS）
const comfortText = await generateSpeechText(payload.text, taskLabel, "ack");
const comfortTts = await synthesizeSpeech(comfortText);
send(ws, { type: ASSISTANT_RESULT, phase: "ack", ... });
```

**效果：** 用户立即听到确认语音（~1s），明确表达"稍等，完成后通知你"的语义，之后异步收到飞书任务结果。

### 4.6 用户画像持久化与异步更新

**问题：** LLM 每次对话需要了解用户背景信息，但不应阻塞主流程。

**优化方案：**
1. 用户画像以 JSON 文件持久化（`memory_store.json`），按 userId 分组
2. 画像更新通过 `asyncio.create_task` 异步执行，不阻塞对话流
3. 画像提取使用独立的低成本模型调用（温度 0，max_tokens 512）
4. 动态字段设计，无固定 schema 限制

### 4.7 前端渐进式渲染优化

**问题：** 原始方案等全部句子到达后才渲染，用户看到内容存在明显延迟。

**优化方案：**
1. LLM 首句到达时先发送文字事件（`displayText` + `ttftMs`），前端立即创建 `_streaming` 状态对象并渲染
2. TTS 合成完成后发送音频事件（`audioBase64` + `ttfaMs`），前端开始播放
3. 后续句子追加到同一对象并刷新 UI
4. 拍照任务创建 placeholder "📷 正在分析拍摄的照片…"
5. 首句到达时替换 placeholder（`phDedup` 去重逻辑）

---

## 五、安全与异常处理

| 场景 | 处理方式 |
|------|----------|
| ASR 服务未配置 | 网关启动不创建 ASR session，返回错误提示 |
| TTS 服务未配置 | `synthesizeSpeech()` 返回 null，前端仅显示文本 |
| ArkClaw 未配置 | `sendTextCommand()` 抛出异常，返回配置提示 |
| VeADK 不可达 | 捕获 fetch 异常，返回 "我暂时无法完成这个请求" |
| TTS 合成超时 | 8s 超时，自动 reject |
| ASR 会话超时 | `finishAndWait(8000)` 8s 超时关闭 |
| WebSocket 断开 | ws.on("close") 清理 server session，前端自动停止音频采集并恢复 UI，需用户手动重新开始 |
| 并发 ArkClaw 调用 | `_lock` 互斥，新调用取消旧调用 |
| 图片解码失败 | 返回 "图片分析失败" + error message |
| 用户画像解析失败 | 仅 warn 日志，不影响主流程 |
| 调试日志过大 | 保留最近 200 条 |
| 会话内存泄漏 | `_cleanup_stale_sessions()` 30min TTL |
| Express body 过大 | `express.json({ limit: "10mb" })` |

---

## 六、项目结构

```
code/
├── apps/
│   ├── glasses-web/         # 浏览器 Demo UI
│   │   ├── src/
│   │   │   ├── main.js      # WebSocket 连接、音频采集/播放、UI 渲染
│   │   │   └── styles.css   # 样式
│   │   ├── index.html
│   │   └── package.json     # Vite + @ai-glasses/shared
│   ├── gateway/             # Node.js 网关
│   │   ├── src/
│   │   │   ├── server.mjs           # 主逻辑：会话管理、意图路由、时延打点
│   │   │   ├── volc-asr-client.mjs  # 火山引擎 ASR WebSocket 客户端
│   │   │   ├── volc-tts-client.mjs  # 火山引擎 TTS WebSocket 客户端
│   │   │   └── arkclaw-client.mjs   # ArkClaw 终端 WebSocket 客户端
│   │   └── package.json     # express + ws + tweetnacl + dotenv + @ai-glasses/shared
│   └── veadk-agent/         # Python Agent 服务
│       ├── app.py           # FastAPI + LLM/VLM/搜索/画像
│       └── requirements.txt # fastapi + uvicorn + httpx + pydantic + python-dotenv
├── packages/
│   └── shared/
│       └── src/
│           └── protocol.mjs # 共享常量：事件名、状态、意图、检测函数
├── scripts/
│   ├── dev.sh               # 一键启动/停止脚本
│   └── smoke-test.mjs       # 烟雾测试
├── docs/
│   ├── architecture.md      # 架构文档
│   ├── protocol.md          # 协议文档
│   └── solution.md          # 本文档
├── .env.example             # 环境变量模板
├── package.json             # 工作区根配置
└── README.md
```

---

## 七、技术选型

| 维度 | 选型 | 原因 |
|------|------|------|
| 网关运行时 | Node.js（Express + ws） | WebSocket 生态成熟，ASR/TTS 客户端与前端统一语言，npm workspaces 管理 monorepo |
| Agent 运行时 | Python（FastAPI + uvicorn） | LLM SDK 生态（httpx SSE 流式消费），Python 社区模型调用最成熟 |
| 前端构建 | Vite | HMR 开发体验好，原生 ESM，零配置 |
| 大模型 | 豆包（doubao-1-5-lite / seed-2-0-mini） | 火山引擎生态内完整闭环（ASR → LLM → TTS），无需跨云 |
| ASR | 火山引擎 bigmodel | 中文识别率高，支持实时流式，WebSocket 双向通信 |
| TTS | 火山引擎 seed-tts-2.0 | 中文自然人声，MP3 输出高压缩比 |
| 搜索 | 火山引擎 Web Search API | 无需额外对接搜索引擎 |
| 前端音频 | Web Audio API | 精确时序控制，支持队列播放和打断 |
| 图片编码 | JPEG + Canvas | 浏览器原生 API，零依赖，压缩比高 |
| 方案管理 | npm workspaces | 跨包共享协议常量，统一依赖管理 |
| Python 环境 | .venv | 隔离系统 Python，可复现环境 |
