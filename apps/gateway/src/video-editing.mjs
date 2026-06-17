const GENERIC_EDIT_PATTERNS = [
  /^帮?我?(把)?(这个|这段|那个|那段|刚刚)?视频(剪一下|剪辑一下|处理一下)?$/i,
  /^帮?我?(把)?(这个|这段|那个|那段|刚刚)?vlog(剪一下|剪辑一下|处理一下)?$/i,
  /^视频剪辑$/i,
  /^vlog剪辑$/i,
];

const FILE_NAME_PATTERNS = [
  /(?:视频|录像|vlog)[^\n"'“”]*?([A-Za-z0-9_\-.]+\.(?:mp4|mov|webm|m4v))/i,
  /([A-Za-z0-9_\-.]+\.(?:mp4|mov|webm|m4v))/i,
  /["“]([^"”]+)["”]/,
];

export function extractRequestedVideoName(text = "") {
  for (const pattern of FILE_NAME_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return "";
}

export function isVideoEditDescriptionAmbiguous(text = "") {
  const normalized = String(text || "").trim().replace(/\s+/g, "");
  return !normalized || GENERIC_EDIT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function buildVideoEditCommand({
  originalText,
  videoUrl,
  outputTosPath,
  fileName,
}) {
  return [
    "请启动一个智能视频剪辑任务，并严格使用以下参数：",
    `video_url: ${videoUrl}`,
    `output_tos_path: ${outputTosPath}`,
    `task_description: ${originalText}`,
    "mode: detail",
    "enable_asr: false",
    fileName ? `补充信息：用户选择的视频文件名是 ${fileName}` : "",
    "如果信息不足，不要自行猜测，请明确指出缺少什么信息。",
    "如果任务成功，请返回简洁结果说明，不要改写输入参数。"
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildVideoSelectionPrompt(originalText, requestedName = "") {
  if (requestedName) {
    return `请在相册中选择要剪辑的视频：${requestedName}`;
  }
  return `请在相册中选择要剪辑的视频。当前需求：${originalText}`;
}
