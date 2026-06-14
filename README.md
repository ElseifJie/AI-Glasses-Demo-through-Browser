# AI Glasses Agent & ArkClaw

浏览器端 AI 智能眼镜 Demo，集成语音识别 (ASR)、大模型对话 (LLM)、视觉理解 (VLM)、语音合成 (TTS)、联网搜索、ArkClaw 终端控制。

## 一键启动

首次运行前先准备 Python 环境：

```bash
cd apps/veadk-agent
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cd ../..
```

```bash
# 启动全部服务
npm run dev:start

# 关闭全部服务
npm run dev:stop

# 查看状态
npm run dev:status

# 查看日志
npm run dev:logs

# 运行烟雾测试
npm run test:smoke
```

启动后打开 **http://localhost:5173**，点击「开始对话」即可使用。

## 架构

```
浏览器 (glasses-web :5173)
  ↕ WebSocket
网关 (gateway :8787)
  ├─ ASR (Volcengine 双向流式)
  ├─ TTS (Volcengine)
  ├─ 意图识别 → 路由分发
  ├─ ArkClaw 终端 (飞书)
  └─ VeADK Agent (:9001)
       ├─ 闲聊 (doubao-1-5-lite)
       ├─ 联网搜索 (Volcengine Web Search)
       ├─ 拍照识别 (doubao-seed-2-0-mini)
       └─ 用户画像 (持久化)
```

## 意图路由

| 优先级 | 意图 | 关键词示例 | 路由 |
|:---:|------|------|:---:|
| 1 | 飞书 | 发消息、查看日程、创建文档、编辑文档、飞书 | ArkClaw |
| 2 | 拍照 | 拍照、这是什么、眼前、手上、拿着、帮我看看、瞧瞧、认得 | 浏览器拍照 → VeADK |
| 3 | 搜索 | 搜索、天气、查一下 | VeADK 联网搜索 |
| 4 | 闲聊 | 其他 | VeADK 大模型 |

## 环境配置

```bash
cp .env.example .env
# 编辑 .env 填入 API Key 等配置
```

### 必填项

| 变量 | 用途 |
|------|------|
| `OPENAI_API_KEY` | 豆包模型 API Key |
| `VOLC_ASR_APP_KEY` / `_ACCESS_KEY` | 火山引擎语音识别 |
| `VOLC_TTS_APP_ID` / `_ACCESS_TOKEN` | 火山引擎语音合成 |
| `TOOL_WEB_SEARCH_ACCESS_KEY` | 火山引擎联网搜索 |

### 可选项

| 变量 | 默认值 | 用途 |
|------|------|------|
| `AGENT_CHAT_MODEL` | `doubao-1-5-lite-32k-250115` | 闲聊、搜索总结 |
| `AGENT_VISION_MODEL` | `doubao-seed-2-0-mini-260428` | 拍照识别 |
| `AGENT_PROMPT_CHAT` | 内置默认 | 闲聊提示词 |
| `AGENT_PROMPT_SEARCH` | 内置默认 | 搜索提示词 |
| `AGENT_PROMPT_VISION` | 内置默认 | 拍照提示词 |
| `AGENT_PROMPT_PROFILE` | 内置默认 | 画像提取提示词 |
| `AGENT_REPLY_FORMAT` | 内置默认 | 回复格式要求 |
| `GATEWAY_URL` / `_INSTANCE` / `_APIKEY` / `_TOKEN` | — | ArkClaw 终端对接 |

## 目录结构

```
apps/
  glasses-web/    浏览器 Demo UI (Vite + WebSocket)
  gateway/        Node.js 网关 (ASR/TTS/意图路由/ArkClaw)
  veadk-agent/    Python Agent (LLM/VLM/搜索/画像)
packages/
  shared/         共享协议常量 (意图/事件/状态)
scripts/
  dev.sh          一键启动/停止脚本
  smoke-test.mjs  烟雾测试
```

## 对话功能

- **语音对话** — 点击「开始对话」授权麦克风和摄像头，直接说话交互
- **手动拍照** — 点击「📷 拍照」按钮拍摄当前画面
- **语音拍照** — 说「拍照」「这是什么」自动触发拍照
- **联网搜索** — 说「搜索最新新闻」「北京天气」自动联网
- **飞书操作** — 说「发消息」「查看日程」「创建文档」调用 ArkClaw
- **历史记录** — 点击「📋 历史记录」查看完整对话和时延链路

## 本地数据

- `apps/veadk-agent/memory_store.json` 是运行时生成的本地用户画像数据文件，仅用于本机调试和会话记忆，不属于项目源码，默认被 `.gitignore` 忽略。
- 需要重置用户画像时，可以直接删除该文件，服务会在后续运行时自动重新生成。
