from __future__ import annotations

import asyncio
import json
import re
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncGenerator

import httpx
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

logger = logging.getLogger("veadk-agent")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")

_load_dotenv_done = False

def _load_env_file() -> None:
    global _load_dotenv_done
    if _load_dotenv_done:
        return
    root_env = Path(__file__).resolve().parents[2] / ".env"
    if root_env.exists():
        load_dotenv(root_env)
    _load_dotenv_done = True

WEB_SEARCH_URL = "https://open.feedcoopapi.com/search_api/web_search"
_searcher: httpx.AsyncClient | None = None
_searcher_lock = asyncio.Lock()
USER_PROFILES_PATH = Path(__file__).with_name("memory_store.json")
MAX_HISTORY_ROUNDS = 3
SESSION_TTL_SECONDS = 1800
SENTENCE_END = ("。", "！", "？", "\n\n")

DEFAULT_PROMPT_CHAT = (
    "你是 AI 眼镜助手，名字叫小助理。"
    "你可以陪用户聊天、回答问题，也能通过联网搜索获取最新信息。"
    "回复风格：简洁、直接、自然，不要刻意寒暄。"
    "除非用户问了复杂问题，否则一句话回答即可。"
    "不要给自己起别的名字。"
    "\n\n你了解用户以下信息，但仅在相关时自然提及，不要生硬复述：\n{user_profile}"
)
DEFAULT_PROMPT_SEARCH = (
    "你是 AI 眼镜助手，具备联网搜索能力。"
    "请根据搜索结果给出准确、简洁、自然的中文答复。"
)
DEFAULT_PROMPT_SPEECH_ACK = (
    "你是 AI 眼镜助手。用户刚才说了一段话，需要你去执行一个飞书任务。"
    "请用一句话简短自然地告诉用户：已收到任务，请稍等，完成后马上通知你。"
    "必须明确表达\"请稍候\"或\"稍等\"的意思，让用户知道你正在处理。"
    "不要寒暄，不要加\"好的\"、\"没问题\"之类的前缀，直接说核心内容。"
    "示例：\"收到，帮你创建日程，稍等片刻，完成后通知你。\""
    "\n用户原话：{user_text}\n任务类型：{task_label}"
)

DEFAULT_PROMPT_SPEECH_RESULT = (
    "你是 AI 眼镜助手。用户之前让你执行了一个飞书任务，现在任务已完成。"
    "请用一句话简短自然地告诉用户任务已完成。"
    "不要寒暄，不要加\"好的\"、\"没问题\"之类的前缀，直接说核心内容。"
    "示例：\"日程已创建好了。\""
    "\n任务类型：{task_label}\n执行结果：{status}"
    "\n请输出一句话（20字以内）："
)

DEFAULT_PROMPT_SPEECH_CHAT = (
    "你是 AI 眼镜助手。以下是你的完整回答，但语音播报需要简短提炼。"
    "请把以下回答浓缩成 1-2 句适合语音播报的话，保留核心信息，去掉寒暄和冗余细节。"
    "不要加前缀，直接说核心内容。"
    "\n完整回答：\n{full_text}"
    "\n请输出简短播报（40字以内）："
)

DEFAULT_PROMPT_VISION = (
    "你是 AI 眼镜助手，负责理解用户刚拍摄的图片。"
    "用一句简短的话描述画面中最重要的内容（适合语音播报），"
    "再用 2-3 句话补充细节。"
)
DEFAULT_REPLY_FORMAT = (
    "当前时间: {current_date} 周{current_weekday} {current_time}。\n"
    "回复要求: 适合语音播报。一句话能说清的绝不两句。"
    "全文控制在 80 字以内。"
    "不要加\u201c好的\u201d、\u201c没问题\u201d、\u201c当然可以\u201d之类的寒暄前缀，直接说核心内容。"
)

URL_PATTERN = re.compile(r"https?://[^\s，。！？\n]+")

DEFAULT_PROMPT_PROFILE = (
    "你需要根据用户输入，提取并更新用户个人信息。\n"
    "\n当前画像（JSON）：\n{profile_json}\n"
    "\n最新用户输入：{user_input}\n"
    "\n请从用户输入中提取所有与用户个人相关的信息，以 JSON key-value 形式输出。\n"
    "字段名可以自由定义，示例：name、age、occupation、location、hobbies、favorite_food、"
    "pet、family、recent_event 等。没有固定字段限制。\n"
    "\n规则：\n"
    "1. 仅当用户明确提及才提取，不要推测\n"
    "2. 新信息与旧信息不冲突时，合并保留\n"
    "3. 新信息与旧信息冲突时，以新信息为准\n"
    "4. 特殊字段 memories：列表，仅存储用户中长期不变或极少变化的事实信息，"
    "例如：职业、学历、居住地、家庭成员、宠物、过敏史、饮食偏好等。"
    "不要记录临时性、一次性的事件（如\u201c今天要出门\u201d、\u201c刚才吃了什么\u201d、\u201c准备去开会\u201d等），"
    "这些不需要长期记忆。去重后保留最近 20 条。\n"
    "5. 其他字段：字符串或数字，如用户未提及则保留原值或省略\n"
    "\n输出 JSON（不要输出其他内容）：\n"
    '{"memories": [...], "任意字段名": "值", ...}'
)


def _load_user_profiles() -> dict[str, Any]:
    if USER_PROFILES_PATH.exists():
        try:
            return json.loads(USER_PROFILES_PATH.read_text("utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _save_user_profiles(profiles: dict[str, Any]) -> None:
    USER_PROFILES_PATH.write_text(
        json.dumps(profiles, ensure_ascii=False, indent=2), "utf-8"
    )


def _now_context() -> dict[str, str]:
    now = datetime.now()
    weekdays = ["一", "二", "三", "四", "五", "六", "日"]
    return {
        "current_date": now.strftime("%Y-%m-%d"),
        "current_time": now.strftime("%H:%M"),
        "current_weekday": weekdays[now.weekday()],
    }


async def web_search(query: str) -> list[str]:
    global _searcher
    api_key = os.getenv("TOOL_WEB_SEARCH_ACCESS_KEY", "")
    if not api_key:
        logger.warning("TOOL_WEB_SEARCH_ACCESS_KEY 未配置，无法执行联网搜索")
        return ["联网搜索未配置，请设置 TOOL_WEB_SEARCH_ACCESS_KEY"]

    async with _searcher_lock:
        if _searcher is None:
            _searcher = httpx.AsyncClient(timeout=10)

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    body = {
        "Query": query,
        "SearchType": "web",
        "Count": 5,
        "Filter": {
            "NeedContent": False,
            "NeedUrl": True,
        },
        "NeedSummary": True,
        "TimeRange": "OneYear",
    }

    try:
        response = await _searcher.post(WEB_SEARCH_URL, headers=headers, json=body)
        response.raise_for_status()
        payload = response.json()
    except httpx.HTTPError as exc:
        logger.error(f"联网搜索请求失败: {exc}")
        return [f"搜索请求失败: {exc}"]

    try:
        results: list[dict[str, Any]] = payload.get("Result", {}).get("WebResults", [])
        if not results:
            return ["未找到相关搜索结果"]

        final_results: list[str] = []
        for item in results:
            title = item.get("Title", "")
            summary = item.get("Summary", "") or item.get("Snippet", "")
            url = item.get("Url", "")
            parts = [f"【{title}】"]
            if summary:
                parts.append(summary[:200])
            if url:
                parts.append(f"来源: {url}")
            final_results.append("\n".join(parts))

        return final_results
    except Exception as exc:
        logger.error(f"解析搜索结果失败: {exc}")
        return [str(payload)]


class ChatRequest(BaseModel):
    sessionId: str
    userId: str | None = None
    text: str | None = None
    intent: str | None = None
    imageDataUrl: str | None = None


class SpeechRequest(BaseModel):
    userText: str
    taskLabel: str = ""
    context: str = "ack"
    status: str = "completed"


class OpenAICompatibleClient:
    def __init__(self) -> None:
        self.api_base = (
            os.getenv("OPENAI_BASE_URL") or "https://ark.cn-beijing.volces.com/api/v3"
        ).rstrip("/")
        self.api_key = os.getenv("OPENAI_API_KEY") or ""

        model_default = os.getenv("AGENT_CHAT_MODEL") or "doubao-1-5-lite-32k-250115"
        self.chat_model = model_default
        self.vision_model = (
            os.getenv("AGENT_VISION_MODEL")
            or self.chat_model
        )

        self.sessions: dict[str, list[dict[str, str]]] = {}
        self.session_user_map: dict[str, str] = {}
        self._session_atimes: dict[str, float] = {}
        self._profile_tasks: set[asyncio.Task[None]] = set()
        self.user_profiles: dict[str, Any] = _load_user_profiles()
        self._http = httpx.AsyncClient(timeout=60)

        self.prompt_chat = DEFAULT_PROMPT_CHAT
        self.prompt_search = DEFAULT_PROMPT_SEARCH
        self.prompt_vision = DEFAULT_PROMPT_VISION
        self.prompt_profile = DEFAULT_PROMPT_PROFILE
        self.reply_format = DEFAULT_REPLY_FORMAT
        self.prompt_speech_ack = DEFAULT_PROMPT_SPEECH_ACK
        self.prompt_speech_result = DEFAULT_PROMPT_SPEECH_RESULT
        self.prompt_speech_chat = DEFAULT_PROMPT_SPEECH_CHAT

        self._completion_url = (
            self.api_base if self.api_base.endswith("/chat/completions")
            else f"{self.api_base}/chat/completions"
        )

    def _schedule_profile_update(self, user_id: str, user_text: str) -> None:
        if not user_id or not user_text:
            return
        task = asyncio.create_task(self._update_profile(user_id, user_text))
        self._profile_tasks.add(task)
        task.add_done_callback(self._profile_tasks.discard)

    def _cleanup_stale_sessions(self) -> None:
        now = asyncio.get_event_loop().time()
        stale = [
            sid for sid, atime in self._session_atimes.items()
            if now - atime > SESSION_TTL_SECONDS
        ]
        for sid in stale:
            self.sessions.pop(sid, None)
            self._session_atimes.pop(sid, None)
            self.session_user_map.pop(sid, None)
        if stale:
            logger.info(f"[session] cleaned up {len(stale)} stale sessions")

    def _render_prompt(self, template: str, session_id: str, extra: dict[str, str] | None = None) -> str:
        nc = _now_context()
        profile_text = self._get_profile_text(session_id)

        result = template.replace("{current_date}", nc["current_date"])
        result = result.replace("{current_time}", nc["current_time"])
        result = result.replace("{current_weekday}", nc["current_weekday"])
        result = result.replace("{user_profile}", profile_text)

        if extra:
            for k, v in extra.items():
                result = result.replace("{" + k + "}", v)

        return result

    def _build_system_prompt(self, role_prompt: str, session_id: str) -> str:
        rendered_role = self._render_prompt(role_prompt, session_id)
        rendered_format = self._render_prompt(self.reply_format, session_id)
        return rendered_role + "\n" + rendered_format

    def _get_profile_text(self, session_id: str) -> str:
        user_id = self.session_user_map.get(session_id, "")
        profile = self.user_profiles.get(user_id, {}) if user_id else {}
        if not profile:
            return "暂无用户信息"

        skip_keys = {"memories", "updated_at", "recent_event"}
        lines = []
        for key, value in profile.items():
            if key in skip_keys:
                continue
            if isinstance(value, list):
                lines.append(f"{key}: {', '.join(str(v) for v in value)}")
            else:
                lines.append(f"{key}: {value}")

        memories = profile.get("memories")
        if memories:
            lines.append(f"近期记忆: {'; '.join(str(m) for m in memories[-5:])}")

        return "\n".join(lines)

    def _record_turn(
        self, session_id: str, user_text: str, assistant_text: str
    ) -> None:
        if session_id not in self.sessions:
            self.sessions[session_id] = []
        history = self.sessions[session_id]
        history.append({"role": "user", "content": user_text})
        history.append({"role": "assistant", "content": assistant_text})

        max_messages = MAX_HISTORY_ROUNDS * 2
        if len(history) > max_messages:
            self.sessions[session_id] = history[-max_messages:]

        self._session_atimes[session_id] = asyncio.get_event_loop().time()

    async def _update_profile(self, user_id: str, user_text: str) -> None:
        if not user_id:
            return
        profile = self.user_profiles.get(user_id, {})
        profile_json = json.dumps(profile, ensure_ascii=False, indent=2)

        prompt = (
            self.prompt_profile
            .replace("{profile_json}", profile_json)
            .replace("{user_input}", user_text)
        )

        try:
            messages = [
                {"role": "system", "content": "你是一个 JSON 输出器。你只输出 JSON，不输出任何其他文字。你的输出必须以 { 开头，以 } 结尾。"},
                {"role": "user", "content": prompt},
            ]
            result = await self._create_completion(
                self.chat_model, messages, max_tokens=512, temperature=0
            )
            result = (result or "").strip()
            if not result:
                return
            if result.startswith("```"):
                result = result.split("\n", 1)[1].rsplit("\n```", 1)[0]
            updated = json.loads(result)

            new_memories = updated.pop("memories", None)
            if new_memories and isinstance(new_memories, list):
                existing_mems = profile.get("memories", [])
                for mem in new_memories:
                    if isinstance(mem, str) and mem.strip() and mem.strip() not in existing_mems:
                        existing_mems.append(mem.strip())
                profile["memories"] = existing_mems[-20:]

            for key, value in updated.items():
                if key == "memories":
                    continue
                if value is not None and value != "":
                    if isinstance(value, str):
                        value = value.strip()
                        if value:
                            profile[key] = value
                    elif isinstance(value, (int, float)):
                        profile[key] = value
                    elif isinstance(value, list):
                        profile[key] = value

            profile["updated_at"] = datetime.now().isoformat()
            self.user_profiles[user_id] = profile
            _save_user_profiles(self.user_profiles)
            logger.info(f"[profile] updated for user={user_id}, keys={sorted(profile.keys())}")
        except (json.JSONDecodeError, Exception) as e:
            logger.warning(f"[profile] update failed for user={user_id}: {e}")

    async def _run_chat_stream(self, request: ChatRequest) -> AsyncGenerator[dict[str, str], None]:
        user_text = request.text or ""
        async for sentence in self._stream_with_profile(
            request,
            model=self.chat_model,
            prompt=self.prompt_chat,
            user_message=user_text,
            record_label=user_text,
        ):
            yield sentence

    async def _run_search_stream(self, request: ChatRequest) -> AsyncGenerator[dict[str, str], None]:
        query = request.text or ""
        search_results = await web_search(query)
        results_text = "\n".join(
            f"{i + 1}. {item}" for i, item in enumerate(search_results)
        )
        full_display: list[str] = []
        async for sentence in self._stream_with_profile(
            request,
            model=self.chat_model,
            prompt=self.prompt_search,
            user_message=f"用户问题：{query}\n\n以下是联网搜索结果：\n{results_text}",
            record_label=query,
        ):
            full_display.append(sentence.get("displayText", ""))
            yield sentence
        yield {"speechText": "", "displayText": f"🔍 **{query}**\n\n{''.join(full_display)}", "final": True}

    async def _run_vision_stream(self, request: ChatRequest) -> AsyncGenerator[dict[str, str], None]:
        user_text = request.text or ""
        async for sentence in self._stream_with_profile(
            request,
            model=self.vision_model,
            prompt=self.prompt_vision,
            user_message=[
                {"type": "text", "text": user_text or "这张图片里有什么？"},
                {"type": "image_url", "image_url": {"url": request.imageDataUrl}},
            ],
            record_label=f"[拍照] {user_text}",
        ):
            yield sentence

    async def _stream_with_profile(
        self,
        request: ChatRequest,
        *,
        model: str,
        prompt: str,
        user_message: str | list[dict[str, Any]],
        record_label: str,
    ) -> AsyncGenerator[dict[str, str], None]:
        session_id = request.sessionId
        user_id = request.userId or ""
        if user_id:
            self.session_user_map[session_id] = user_id

        self._cleanup_stale_sessions()

        system_prompt = self._build_system_prompt(prompt, session_id)
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
        ]

        history = self.sessions.get(session_id, [])
        if history:
            messages.extend(history[-MAX_HISTORY_ROUNDS * 2:])

        if isinstance(user_message, str):
            messages.append({"role": "user", "content": user_message})
        else:
            messages.append({"role": "user", "content": user_message})

        full_content: list[str] = []
        async for sentence in self._create_completion_stream(model, messages, max_tokens=256):
            full_content.append(sentence)
            yield {"speechText": self._speech_summary(sentence), "displayText": sentence}

        full_text = "".join(full_content)
        self._record_turn(session_id, record_label, full_text)
        self._schedule_profile_update(user_id, request.text or "")

    async def run_stream(self, request: ChatRequest) -> AsyncGenerator[dict[str, str], None]:
        if not self.api_key:
            yield {"speechText": "模型服务还没有配置好。", "displayText": "缺少 OPENAI_API_KEY，当前无法调用模型。"}
            return

        sid = request.sessionId
        user_id = request.userId or ""
        if user_id:
            self.session_user_map[sid] = user_id
        if sid not in self.sessions:
            self.sessions[sid] = []

        if request.imageDataUrl:
            async for sentence in self._run_vision_stream(request):
                yield sentence
        elif request.intent == "web_search":
            async for sentence in self._run_search_stream(request):
                yield sentence
        else:
            async for sentence in self._run_chat_stream(request):
                yield sentence

    async def run_once(self, request: ChatRequest) -> dict[str, str]:
        speech_parts: list[str] = []
        display_text = ""

        async for sentence in self.run_stream(request):
            if sentence.get("final"):
                display_text = sentence.get("displayText") or display_text
                continue
            speech = sentence.get("speechText") or ""
            display = sentence.get("displayText") or ""
            if speech:
                speech_parts.append(speech)
            if display:
                display_text += display

        full_speech = "".join(speech_parts).strip()
        full_display = display_text.strip()
        return {
            "speechText": full_speech or self._speech_summary(full_display),
            "displayText": full_display or full_speech,
        }

    async def summarize_speech(self, user_text: str, task_label: str, context: str = "ack", status: str = "completed") -> str:
        if context == "result":
            prompt = self.prompt_speech_result
            prompt = prompt.replace("{task_label}", task_label)
            prompt = prompt.replace("{status}", status)
        elif context == "chat":
            prompt = self.prompt_speech_chat
            prompt = prompt.replace("{full_text}", user_text)
        else:
            prompt = self.prompt_speech_ack
            prompt = prompt.replace("{user_text}", user_text)
            prompt = prompt.replace("{task_label}", task_label)

        try:
            messages = [
                {"role": "system", "content": "你是一个简短语音播报生成器，只输出一句话，不超过40字。"},
                {"role": "user", "content": prompt},
            ]
            result = await self._create_completion(
                self.chat_model, messages, max_tokens=128, temperature=0.2
            )
            return result.strip() or f"收到，你的{task_label}任务稍等片刻，完成后通知你。"
        except Exception as exc:
            logger.warning(f"[speech] summarize failed: {exc}")
            if context == "result":
                return f"你的{task_label}任务已完成。"
            if context == "chat":
                return user_text[:100]
            return f"收到，你的{task_label}任务稍等片刻，完成后通知你。"

    async def _create_completion(
        self,
        model: str,
        messages: list[dict[str, Any]],
        max_tokens: int = 1024,
        temperature: float = 0.3,
    ) -> str:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        body = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
        try:
            response = await self._http.post(self._completion_url, headers=headers, json=body)
            response.raise_for_status()
            payload = response.json()
            return payload["choices"][0]["message"]["content"].strip()
        except Exception as exc:
            logger.error(f"[completion] model={model} error: {exc}")
            return ""

    async def _create_completion_stream(
        self,
        model: str,
        messages: list[dict[str, Any]],
        max_tokens: int = 1024,
        temperature: float = 0.3,
    ) -> AsyncGenerator[str, None]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        body = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": True,
        }
        buffer = ""
        async with self._http.stream("POST", self._completion_url, headers=headers, json=body) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line or not line.startswith("data: "):
                    continue
                data = line[6:]
                if data == "[DONE]":
                    break
                try:
                    delta = json.loads(data)
                    content = delta.get("choices", [{}])[0].get("delta", {}).get("content", "")
                    if not content:
                        continue
                    buffer += content
                    if buffer.rstrip().endswith(SENTENCE_END):
                        yield buffer.strip()
                        buffer = ""
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue
        if buffer.strip():
            yield buffer.strip()

    @staticmethod
    def _speech_summary(text: str) -> str:
        compact = " ".join(text.split())
        has_url = bool(URL_PATTERN.search(compact))
        clean = URL_PATTERN.sub("", compact).strip()
        clean = re.sub(r"\s+", " ", clean)

        sentences = []
        remaining = clean
        for delimiter in ["。", "！", "？", ".", "!", "?"]:
            while delimiter in remaining:
                idx = remaining.index(delimiter)
                sentence = remaining[:idx + 1].strip()
                if sentence:
                    sentences.append(sentence)
                remaining = remaining[idx + 1:].strip()
            if sentences:
                break

        if not sentences:
            text_body = clean[:200]
        else:
            combined = ""
            for s in sentences[:2]:
                if len(combined) + len(s) <= 200:
                    combined += s
                else:
                    break
            text_body = combined if combined else sentences[0][:200]

        if has_url:
            text_body = text_body.rstrip("，。；,.;") + "。答复中有链接，详细内容可以点击查看"
        elif len(compact) > 200:
            text_body = text_body.rstrip("，。；,.;") + "。详细内容可以查看手机页面详情"

        return text_body


app = FastAPI(title="veadk-agent-service")
_load_env_file()
agent_client = OpenAICompatibleClient()


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "veadk-agent-service",
        "chat_model": agent_client.chat_model,
        "vision_model": agent_client.vision_model,
    }


@app.post("/chat")
async def chat_once(request: ChatRequest) -> dict[str, str]:
    return await agent_client.run_once(request)


@app.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    async def generate():
        async for sentence in agent_client.run_stream(request):
            yield f"data: {json.dumps(sentence, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/speech")
async def speech_text(request: SpeechRequest) -> dict[str, str]:
    text = await agent_client.summarize_speech(
        request.userText, request.taskLabel, request.context, request.status
    )
    return {"speechText": text}

@app.get("/profile/{user_id}")
async def get_profile(user_id: str) -> dict[str, Any]:
    profile = agent_client.user_profiles.get(user_id, {})
    return {
        "userId": user_id,
        "profile": profile,
        "exists": bool(profile)
    }


@app.delete("/profile/{user_id}")
async def delete_profile(user_id: str) -> dict[str, str]:
    if user_id in agent_client.user_profiles:
        del agent_client.user_profiles[user_id]
        _save_user_profiles(agent_client.user_profiles)
        return {"status": "deleted", "userId": user_id}
    return {"status": "not_found", "userId": user_id}


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=os.getenv("AGENT_HOST", "127.0.0.1"),
        port=int(os.getenv("AGENT_PORT", "9001")),
    )
