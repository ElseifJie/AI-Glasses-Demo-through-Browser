# AI Glasses Agent & ArkClaw

浏览器端 AI 智能眼镜 Demo，集成语音识别 (ASR)、大模型对话 (LLM)、视觉理解 (VLM)、语音合成 (TTS)、联网搜索、ArkClaw 终端控制。

## 启动方式

首次运行前先准备 Python 环境：

```bash
cd apps/veadk-agent
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cd ../..
```

```bash
# 启动全部服务（本地联调）
npm run dev:start

# 只启动前端（本机模拟 AI 眼镜）
npm run dev:frontend

# 只启动后端（veadk-agent + gateway）
npm run dev:backend

# 关闭全部服务
npm run dev:stop

# 单独关闭前端 / 后端
npm run dev:frontend:stop
npm run dev:backend:stop

# 查看状态
npm run dev:status

# 查看日志
npm run dev:logs

# 运行烟雾测试
npm run test:smoke
```

前端默认打开 **http://localhost:5173**。

当前推荐的拆分运行方式：

```bash
# 1. 本机启动前端
npm run dev:frontend

# 2. 本机或远端启动后端
npm run dev:backend
```

如果后端不在本机，需要把根目录 `.env` 里的 `VITE_GATEWAY_WS_URL` 改成后端网关地址，例如：

```bash
VITE_GATEWAY_WS_URL=ws://your-gateway-host:8787
WEB_ORIGIN=http://localhost:5173,http://127.0.0.1:5173
```

## 架构

```
浏览器 (glasses-web :5173)
  ↕ WebSocket（可独立配置目标 gateway）
网关 (gateway :8787)
  ├─ ASR (Volcengine 双向流式)
  ├─ TTS (Volcengine)
  ├─ 意图识别 → 路由分发
  ├─ ArkClaw 终端 (飞书 + 视频剪辑)
  ├─ TOS 对象存储 (视频上传/下载)
  └─ VeADK Agent (:9001)
       ├─ 闲聊 (doubao-1-5-lite)
       ├─ 联网搜索 (Volcengine Web Search)
       ├─ 拍照识别 (doubao-seed-2-0-mini)
       └─ 用户画像 (持久化)
```

## 意图路由

| 优先级 | 意图 | 关键词示例 | 路由 |
|:---:|------|------|:---:|
| 1 | 视频剪辑 | 剪辑、剪一下、highlight、vlog | ArkClaw 终端 |
| 2 | 视频选择 | 第一个、最新的、这个 | 浏览器相册 → ArkClaw |
| 3 | 飞书 | 发消息、查看日程、创建文档、编辑文档、飞书 | ArkClaw |
| 4 | 停止录制 | 停止录制、结束录制、停 | 浏览器停止录制 |
| 5 | 录制视频 | 录制、开始录像、拍视频 | 浏览器录制 |
| 6 | 拍照 | 拍照、这是什么、眼前、手上、拿着、帮我看看、瞧瞧、认得 | 浏览器拍照 → VeADK |
| 7 | 搜索 | 搜索、天气、查一下 | VeADK 联网搜索 |
| 8 | 闲聊 | 其他 | VeADK 大模型 |

## 环境配置

```bash
cp .env.example .env
# 编辑 .env 填入 API Key 等配置
```

### 必填项

| 变量 | 用途 |
|------|------|
| `OPENAI_API_KEY` | 豆包模型 API Key |
| `VOLC_ASR_APP_KEY` | 火山引擎语音识别 App Key |
| `VOLC_ASR_ACCESS_KEY` | 火山引擎语音识别 Access Key |
| `VOLC_TTS_APP_ID` | 火山引擎语音合成 App ID |
| `VOLC_TTS_ACCESS_TOKEN` | 火山引擎语音合成 Access Token |
| `TOOL_WEB_SEARCH_ACCESS_KEY` | 火山引擎联网搜索 |

### 常用可选

| 变量 | 默认值 | 用途 |
|------|------|------|
| `HOST` | `127.0.0.1` | gateway 监听地址，独立部署时可改成 `0.0.0.0` |
| `WEB_ORIGIN` | `http://localhost:5173,http://127.0.0.1:5173` | 允许访问 gateway 的前端来源，支持逗号分隔多个来源 |
| `VITE_GATEWAY_WS_URL` | `ws://127.0.0.1:8787` | 前端连接的 gateway WebSocket 地址 |
| `TOS_ORIGIN_VIDEO_PREFIX` | `tos://your-bucket/ai-glasses/origin-video/` | 原始视频上传目录 |
| `TOS_OUTPUT_VIDEO_PREFIX` | `tos://your-bucket/ai-glasses/output-video/` | 剪辑结果输出目录 |
| `OPENAI_BASE_URL` | `https://ark.cn-beijing.volces.com/api/v3/chat/completions` | 模型 API 地址 |
| `AGENT_CHAT_MODEL` | `doubao-1-5-lite-32k-250115` | 闲聊、搜索总结 |
| `AGENT_VISION_MODEL` | `doubao-seed-2-0-mini-260428` | 拍照识别 |
| `GATEWAY_URL` / `_INSTANCE` / `_APIKEY` / `_TOKEN` | — | ArkClaw 终端对接 |

### 高级覆盖

| 变量 | 说明 |
|------|------|
| `VOLC_ASR_RESOURCE_ID` | ASR 实例资源 ID |
| `VOLC_ASR_URL` | ASR 服务地址覆盖 |
| `VOLC_TTS_RESOURCE_ID` | TTS 实例资源 ID |
| `VOLC_TTS_VOICE_TYPE` | TTS 音色类型 |
| `VOLC_TTS_URL` | TTS 服务地址覆盖 |

## Push 前检查

公开推送到 GitHub 前，至少确认以下几点：

- 本地私密文件没有加入版本管理：`.env`、`.arkclaw-device.json`、`.dev-logs/`、`.dev-pids`、`apps/veadk-agent/memory_store.json`
- `.env.example` 只保留占位符，不保留真实 bucket、token、设备身份信息
- 运行 `npm run check:repo`，确认基础语法和意图路由检查通过
- 如需提交视频剪辑相关能力，确认新增文件已纳入版本管理：`apps/gateway/src/intent-rewriter.mjs`、`apps/gateway/src/tos-client.mjs`、`apps/gateway/src/video-editing.mjs`、`apps/glasses-web/src/media-library.js`、`apps/glasses-web/public/audio-processor.js`、`apps/glasses-web/vite.config.js`、`scripts/test-video-intent.mjs`、`scripts/test-video-ws.mjs`

## 目录结构

```
apps/
  glasses-web/    浏览器 Demo UI (Vite + WebSocket)
  gateway/        Node.js 网关 (ASR/TTS/意图路由/ArkClaw)
  veadk-agent/    Python Agent (LLM/VLM/搜索/画像)
packages/
  shared/         共享协议常量 (意图/事件/状态)
scripts/
  dev.sh          前后端分离启动脚本
  smoke-test.mjs  烟雾测试
```

## 部署拆分

前端：

- `glasses-web` 只依赖浏览器能力和 `VITE_GATEWAY_WS_URL`
- 可以继续运行在本地 Mac，模拟 AI 眼镜

后端：

- `gateway` 与 `veadk-agent` 可以单独部署和运行
- `gateway` 通过 `WEB_ORIGIN` 限制允许接入的前端来源
- `gateway` 通过 `HOST` 控制监听地址

## 对话功能

- **语音对话** — 点击「开始对话」授权麦克风和摄像头，直接说话交互
- **手动拍照** — 点击「📷 拍照」按钮拍摄当前画面
- **视频录制** — 说“拍个视频”“录制一下”或点击「🎬 录视频」开始录制，录制内容会保存到本地相册
- **视频剪辑** — 说“视频剪辑”“Vlog剪辑”等指令后，从本地相册选择视频，gateway 会上传到 TOS 并调用 ArkClaw 完成剪辑
- **语音拍照** — 说「拍照」「这是什么」自动触发拍照
- **联网搜索** — 说「搜索最新新闻」「北京天气」自动联网
- **飞书操作** — 说「发消息」「查看日程」「创建文档」调用 ArkClaw
- **本地调试** — 点击「📋 历史记录」查看对话回溯和时延诊断面板，点击「🗂 相册」查看本机保存的照片和视频

## 本地数据

- `apps/veadk-agent/memory_store.json` 是运行时生成的本地用户画像数据文件，仅用于本机调试和会话记忆，不属于项目源码，默认被 `.gitignore` 忽略。
- 需要重置用户画像时，可以直接删除该文件，服务会在后续运行时自动重新生成。
