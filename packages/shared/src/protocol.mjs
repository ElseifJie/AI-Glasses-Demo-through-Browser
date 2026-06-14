export const SessionState = Object.freeze({
  IDLE: "idle",
  LISTENING: "listening",
  THINKING: "thinking",
  DELEGATING: "delegating_to_arkclaw",
  SPEAKING: "speaking"
});

export const ClientEvent = Object.freeze({
  SESSION_START: "session.start",
  SESSION_STOP: "session.stop",
  TRANSCRIPT_USER: "transcript.user",
  AUDIO_CHUNK: "audio.chunk",
  PHOTO_CAPTURE: "photo.capture"
});

export const ServerEvent = Object.freeze({
  SESSION_STATE: "session.state",
  TRANSCRIPT_PARTIAL: "transcript.partial",
  ASSISTANT_RESULT: "assistant.result",
  ASSISTANT_TASK: "assistant.task",
  ASSISTANT_ERROR: "assistant.error",
  CAPTURE_PHOTO_REQUEST: "capture.photo.request"
});

export const Intent = Object.freeze({
  GENERAL_CHAT: "general_chat",
  SEND_FEISHU_MESSAGE: "send_feishu_message",
  IMAGE_UNDERSTANDING: "image_understanding",
  WEB_SEARCH: "web_search",
  TAKE_PHOTO: "take_photo"
});

const FEISHU_PATTERNS = [
  /发消息/,
  /发送消息/,
  /查看消息/,
  /新建日程/,
  /创建日程/,
  /删除日程/,
  /查看日程/,
  /新建文档/,
  /创建文档/,
  /编辑文档/,
  /修改文档/,
  /查看文档/,
  /send.*message/i,
  /create.*doc/i,
  /create.*calendar/i,
  /create.*schedule/i,
  /create.*event/i,
];

const SEARCH_PATTERNS = [
  /搜索/,
  /搜一下/,
  /查一下/,
  /帮我查/,
  /帮我搜/,
  /查查/,
  /搜搜/,
  /今天.*新闻/,
  /现在.*什么/,
  /实时/,
  /天气/,
  /气温/,
  /.*温度/,
  /.*预报/,
  /.*股票/,
  /.*汇率/,
  /what.*today/i,
];

const PHOTO_PATTERNS = [
  /拍照/,
  /拍拍/,
  /拍张/,
  /拍一下/,
  /拍个/,
  /这是什么/,
  /那是什么/,
  /眼前.*什么/,
  /看到.*什么/,
  /看见.*什么/,
  /看看.*什么/,
  /什么.*东西/,
  /手上.*什么/,
  /拿着.*什么/,
  /手里.*什么/,
  /面前.*什么/,
  /桌上.*什么/,
  /帮我看看/,
  /看看这/,
  /瞧瞧/,
  /认得/,
  /认识/,
  /识别一下/,
  /扫一扫/,
  /扫一下/,
  /拍下来/,
  /what.*(this|that)/i,
  /what.*(am i|are we).*(looking|seeing|holding)/i,
  /what.*(in front|in my hand|on the table)/i,
  /identify/i,
  /recognize/i,
];

export function detectIntent(text = "", hasImage = false) {
  if (hasImage) {
    return Intent.IMAGE_UNDERSTANDING;
  }

  if (FEISHU_PATTERNS.some((pattern) => pattern.test(text))) {
    return Intent.SEND_FEISHU_MESSAGE;
  }

  if (PHOTO_PATTERNS.some((pattern) => pattern.test(text))) {
    return Intent.TAKE_PHOTO;
  }

  if (SEARCH_PATTERNS.some((pattern) => pattern.test(text))) {
    return Intent.WEB_SEARCH;
  }

  return Intent.GENERAL_CHAT;
}

export function createSessionState(state, message, sessionId) {
  return {
    type: ServerEvent.SESSION_STATE,
    sessionId,
    state,
    message
  };
}
