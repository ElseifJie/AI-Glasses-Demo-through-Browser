# VeADK Agent

Python 智能体服务，处理默认对话、联网搜索、图片识别和用户画像。

## 职责

- 通过 OpenAI 兼容 API 调用豆包大模型（doubao-1-5-lite / doubao-seed-2-0-mini）
- 闲聊对话（流式 SSE）
- 联网搜索（火山引擎 Web Search API）
- 图片识别（VLM 多模态）
- 语音播报文本生成（/speech API，支持 ack/result/chat 三种上下文）
- 用户画像（持久化到 `memory_store.json`）

## 本地数据

- `memory_store.json` 是运行时生成的本地用户画像缓存，包含用户画像和近期记忆。
- 该文件只应保留在本机，不参与版本管理；项目根目录的 `.gitignore` 已默认忽略它。
- 如需清空用户画像，删除该文件即可，服务会在写入新画像时自动重建。

## 配置

所有配置从项目根目录 `.env` 文件加载，支持以下变量：

| 变量 | 用途 |
|------|------|
| `OPENAI_BASE_URL` | 模型 API 地址 |
| `OPENAI_API_KEY` | 模型 API Key |
| `AGENT_CHAT_MODEL` | 闲聊/搜索/语音摘要模型 |
| `AGENT_VISION_MODEL` | 拍照识别模型 |
| `TOOL_WEB_SEARCH_ACCESS_KEY` | 火山引擎搜索 Key |

> 提示词（闲聊、搜索、视觉、画像、语音播报、回复格式）已内置在 `app.py` 的 `DEFAULT_PROMPT_*` 常量中，无需通过环境变量配置。

## API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/chat` | POST | 单次对话 |
| `/chat/stream` | POST | 流式对话（SSE） |
| `/speech` | POST | 语音播报文本生成 |
| `/profile/{user_id}` | GET | 查询用户画像 |
| `/profile/{user_id}` | DELETE | 删除用户画像 |

### `/speech` 接口

```json
// 请求
{ "userText": "...", "taskLabel": "创建文档", "context": "ack", "status": "completed" }

// 响应
{ "speechText": "收到，帮你创建文档，稍等片刻，完成后通知你。" }
```

`context` 取值：
- `ack` — ArkClaw 安抚阶段
- `result` — ArkClaw 结果返回阶段
- `chat` — 聊天场景语音摘要

## 启动

```bash
cd apps/veadk-agent
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```
