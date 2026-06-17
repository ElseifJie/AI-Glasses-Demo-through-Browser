import { Intent } from "@ai-glasses/shared";

export function rewriteForArkClaw(text, intent, context = {}) {
  switch (intent) {
    case Intent.SEND_FEISHU_MESSAGE:
      return `请以用户身份（default 模式）执行以下操作，所有创建的文档、日程均以用户的身份创建：\n${text}`;

    case Intent.EDIT_VIDEO:
      return text;

    case Intent.GENERAL_CHAT:
      return text;

    default:
      return text;
  }
}

export function rewriteArkClawFollowUp(userReply, originalCommand) {
  return `用户回复：${userReply}\n\n原始任务：${originalCommand}`;
}