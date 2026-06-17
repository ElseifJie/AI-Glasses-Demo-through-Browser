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
  PHOTO_CAPTURE: "photo.capture",
  VIDEO_EDIT_SELECTION: "video.edit.selection"
});

export const ServerEvent = Object.freeze({
  SESSION_STATE: "session.state",
  TRANSCRIPT_PARTIAL: "transcript.partial",
  ASSISTANT_RESULT: "assistant.result",
  ASSISTANT_TASK: "assistant.task",
  ASSISTANT_ERROR: "assistant.error",
  CAPTURE_PHOTO_REQUEST: "capture.photo.request",
  CAPTURE_VIDEO_REQUEST: "capture.video.request",
  STOP_VIDEO_REQUEST: "stop.video.request",
  MEDIA_PICK_REQUEST: "media.pick.request",
  MEDIA_PICK_SELECT: "media.pick.select"
});

export const Intent = Object.freeze({
  GENERAL_CHAT: "general_chat",
  SEND_FEISHU_MESSAGE: "send_feishu_message",
  IMAGE_UNDERSTANDING: "image_understanding",
  WEB_SEARCH: "web_search",
  TAKE_PHOTO: "take_photo",
  TAKE_VIDEO: "take_video",
  STOP_VIDEO: "stop_video",
  EDIT_VIDEO: "edit_video",
  VIDEO_SELECT: "video_select"
});

const FEISHU_PATTERNS = [
  /发.*消息/,
  /发送.*消息/,
  /查看.*消息/,
  /新建.*日程/,
  /创建.*日程/,
  /删除.*日程/,
  /查看.*日程/,
  /新建.*文档/,
  /创建.*文档/,
  /编辑.*文档/,
  /修改.*文档/,
  /查看.*文档/,
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

const VIDEO_EDIT_PATTERNS = [
  /视频剪辑/,
  /剪辑视频/,
  /(帮我|给我|来|我要|请|帮忙).*剪辑/,
  /剪辑.*(视频|一下|这个|那个)/,
  /剪一下/,
  /帮我剪/,
  /剪个vlog/i,
  /vlog剪辑/i,
  /剪成vlog/i,
  /做个vlog/i,
  /video edit/i,
  /edit.*video/i,
  /highlight.*(video|reel|clip)/i,
  /create.*highlight/i,
];

export const VIDEO_SELECT_PATTERNS = [
  /^第.{1,3}个/,
  /^选.{1,3}个/,
  /^就.{0,3}个/,
  /^这个/,
  /^那个/,
  /^选这个/,
  /^选那个/,
  /^就这个/,
  /^就那个/,
  /^要这个/,
  /^要那个/,
  /^第一个/,
  /^第二个/,
  /^第三个/,
  /^第四个/,
  /^第五个/,
  /^最新的/,
  /^最后的/,
  /^最近.*那个/,
  /^刚才.*那个/,
  /^最长的/,
  /^最短的/,
  /^最新的一个/,
  /^最后的一个/,
  /^选.*\.mp4/i,
  /^选.*\.mov/i,
  /^选.*\.webm/i,
];

const VIDEO_PATTERNS = [
  /拍.{0,3}视频/,
  /录.{0,3}视频/,
  /录制/,
  /录一段/,
  /拍一段/,
  /录像/,
  /开始录/,
  /录个vlog/i,
  /shoot.*video/i,
  /record.*video/i,
  /take.*video/i,
];

const STOP_VIDEO_PATTERNS = [
  /停止录制/,
  /停止录像/,
  /停止拍摄/,
  /结束录制/,
  /结束录像/,
  /结束拍摄/,
  /录制结束/,
  /录像结束/,
  /录制停止/,
  /录像停止/,
  /别录了/,
  /不要录了/,
  /停一下录制/,
  /stop.*record/i,
  /stop.*video/i,
];

const PHOTO_PATTERNS = [
  /拍照/,
  /拍拍/,
  /拍张/,
  /拍.*照片/,
  /拍一下/,
  /拍个/,
  /拍一张/,
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

  if (VIDEO_EDIT_PATTERNS.some((pattern) => pattern.test(text))) {
    return Intent.EDIT_VIDEO;
  }

  if (FEISHU_PATTERNS.some((pattern) => pattern.test(text))) {
    return Intent.SEND_FEISHU_MESSAGE;
  }

  if (STOP_VIDEO_PATTERNS.some((pattern) => pattern.test(text))) {
    return Intent.STOP_VIDEO;
  }

  if (VIDEO_PATTERNS.some((pattern) => pattern.test(text))) {
    return Intent.TAKE_VIDEO;
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
