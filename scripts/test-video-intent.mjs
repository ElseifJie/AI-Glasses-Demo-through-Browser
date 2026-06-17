import { detectIntent, Intent } from "@ai-glasses/shared";

const cases = [
  ["帮我剪辑视频", Intent.EDIT_VIDEO],
  ["剪辑我录的视频", Intent.EDIT_VIDEO],
  ["剪一下录的视频", Intent.EDIT_VIDEO],
  ["帮我剪一下这个视频", Intent.EDIT_VIDEO],
  ["剪辑一下", Intent.EDIT_VIDEO],
  ["帮我剪辑", Intent.EDIT_VIDEO],
  ["录制视频", Intent.TAKE_VIDEO],
  ["录视频", Intent.TAKE_VIDEO],
  ["拍个视频", Intent.TAKE_VIDEO],
  ["录制一段", Intent.TAKE_VIDEO],
  ["开始录像", Intent.TAKE_VIDEO],
  ["停止录制", Intent.STOP_VIDEO],
  ["停止录像", Intent.STOP_VIDEO],
  ["结束录制", Intent.STOP_VIDEO],
  ["录制结束", Intent.STOP_VIDEO],
  ["别录了", Intent.STOP_VIDEO],
  ["发消息给张三", Intent.SEND_FEISHU_MESSAGE],
  ["拍照", Intent.TAKE_PHOTO],
  ["搜索天气", Intent.WEB_SEARCH],
];

let allPassed = true;
for (const [text, expected] of cases) {
  const result = detectIntent(text);
  const pass = result === expected;
  const mark = pass ? "✓" : "✗";
  const extra = pass ? "" : ` (expected ${expected})`;
  console.log(`${mark} ${JSON.stringify(text)} -> ${result}${extra}`);
  if (!pass) allPassed = false;
}

console.log(allPassed ? "\nAll tests passed!" : "\nSome tests failed!");
process.exit(allPassed ? 0 : 1);