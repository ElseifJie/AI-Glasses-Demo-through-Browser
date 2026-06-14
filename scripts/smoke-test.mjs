import "dotenv/config";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { WebSocket } from "ws";
import { VolcAsrClient } from "../apps/gateway/src/volc-asr-client.mjs";
import { VolcTtsClient } from "../apps/gateway/src/volc-tts-client.mjs";

const veadkAgentUrl = process.env.VEADK_AGENT_URL || "http://127.0.0.1:9001";
const gatewayUrl = process.env.GATEWAY_WS_URL || "ws://127.0.0.1:8787";
const gatewayHealthUrl = process.env.GATEWAY_HTTP_URL || "http://127.0.0.1:8787";
const webAppUrl = process.env.WEB_APP_URL || "";
const sampleImageUrl = "https://portal.volccdn.com/obj/volcfe/misc/favicon.png";
const volcTtsClient = new VolcTtsClient(process.env);
const volcAsrClient = new VolcAsrClient(process.env);

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function waitForJson(url, label) {
  const deadline = Date.now() + 30_000;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  throw new Error(`${label} health check failed: ${lastError?.message || "timeout"}`);
}

async function testVeadkText() {
  const response = await fetch(`${veadkAgentUrl}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: randomUUID(),
      text: "请用一句话介绍你自己",
      intent: "general_chat"
    })
  });

  if (!response.ok) {
    throw new Error(`veadk text chat returned ${response.status}`);
  }

  const payload = await response.json();
  if (!payload.displayText || !payload.speechText) {
    throw new Error("veadk text chat returned an empty payload");
  }

  log(`[pass] veadk text -> ${payload.speechText}`);
}

async function testVolcTts() {
  if (!volcTtsClient.isConfigured()) {
    throw new Error("Volc TTS env vars are missing");
  }

  const result = await volcTtsClient.synthesize("你好，我是火山语音测试。", {
    format: "pcm",
    sampleRate: 16000
  });

  if (!result?.audioBuffer?.length) {
    throw new Error("volc TTS returned empty audio");
  }

  log(`[pass] volc tts -> ${result.audioBuffer.length} bytes`);
  return result.audioBuffer;
}

async function testVolcAsr(audioBuffer) {
  if (!volcAsrClient.isConfigured()) {
    throw new Error("Volc ASR env vars are missing");
  }

  const result = await volcAsrClient.transcribeBuffer({
    audioBuffer,
    format: "pcm",
    sampleRate: 16000,
    bits: 16,
    channel: 1
  });

  if (!result.text) {
    throw new Error("volc ASR returned empty transcript");
  }

  if (!/你好|火山|语音|测试/.test(result.text)) {
    throw new Error(`unexpected ASR transcript: ${result.text}`);
  }

  log(`[pass] volc asr -> ${result.text}`);
}

async function testVeadkVision() {
  const response = await fetch(`${veadkAgentUrl}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: randomUUID(),
      text: "请描述这张图片",
      intent: "image_understanding",
      imageDataUrl: sampleImageUrl
    })
  });

  if (!response.ok) {
    throw new Error(`veadk image chat returned ${response.status}`);
  }

  const payload = await response.json();
  if (!payload.displayText || !payload.speechText) {
    throw new Error("veadk image chat returned an empty payload");
  }

  log(`[pass] veadk vision -> ${payload.speechText}`);
}

async function collectGatewayResult(sendEvents, assertResult) {
  const sessionId = randomUUID();

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(gatewayUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("gateway websocket test timed out"));
    }, 30_000);

    const cleanup = () => clearTimeout(timeout);

    ws.on("open", () => {
      for (const event of sendEvents(sessionId)) {
        ws.send(JSON.stringify(event));
      }
    });

    ws.on("message", (buffer) => {
      const payload = JSON.parse(buffer.toString());
      if (payload.sessionId !== sessionId) {
        return;
      }

      if (payload.type === "assistant.error") {
        cleanup();
        ws.close();
        reject(new Error(payload.message));
        return;
      }

      if (payload.type === "assistant.result") {
        try {
          assertResult(payload);
          cleanup();
          ws.close();
          resolve(payload);
        } catch (error) {
          cleanup();
          ws.close();
          reject(error);
        }
      }
    });

    ws.on("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

async function testGatewayChat() {
  const payload = await collectGatewayResult(
    (sessionId) => [
      { type: "session.start", sessionId },
      { type: "transcript.user", sessionId, text: "请用一句话介绍北京", source: "smoke-test" }
    ],
    (result) => {
      if (result.route !== "veadk") {
        throw new Error(`expected veadk route, got ${result.route}`);
      }
      if (!result.displayText || !result.speechText) {
        throw new Error("gateway text result was empty");
      }
    }
  );

  log(`[pass] gateway chat -> ${payload.speechText}`);
}

async function testGatewayImage() {
  const payload = await collectGatewayResult(
    (sessionId) => [
      { type: "session.start", sessionId },
      {
        type: "photo.capture",
        sessionId,
        mimeType: "image/png",
        dataUrl: sampleImageUrl
      }
    ],
    (result) => {
      if (result.route !== "veadk") {
        throw new Error(`expected veadk route for image flow, got ${result.route}`);
      }
      if (!result.displayText || !result.speechText) {
        throw new Error("gateway image result was empty");
      }
    }
  );

  log(`[pass] gateway image -> ${payload.speechText}`);
}

async function testGatewayArkClaw() {
  const payload = await collectGatewayResult(
    (sessionId) => [
      { type: "session.start", sessionId },
      {
        type: "transcript.user",
        sessionId,
        text: "请发飞书给张三：十分钟后开会",
        source: "smoke-test"
      }
    ],
    (result) => {
      if (result.route !== "arkclaw") {
        throw new Error(`expected arkclaw route, got ${result.route}`);
      }
      if (!result.displayText || !result.speechText) {
        throw new Error("gateway arkclaw result was empty");
      }
      if (!/配对|完成|处理/.test(result.displayText)) {
        throw new Error(`unexpected arkclaw result: ${result.displayText}`);
      }
    }
  );

  log(`[pass] gateway arkclaw -> ${payload.displayText}`);
}

async function testWebApp() {
  if (!webAppUrl) {
    return;
  }

  const response = await fetch(webAppUrl);
  if (!response.ok) {
    throw new Error(`web app returned ${response.status}`);
  }

  const html = await response.text();
  if (!html.includes("AI Glasses Demo")) {
    throw new Error("web app homepage content check failed");
  }

  log(`[pass] web app -> ${webAppUrl}`);
}

async function main() {
  const veadkHealth = await waitForJson(`${veadkAgentUrl}/health`, "veadk-agent");
  const gatewayHealth = await waitForJson(`${gatewayHealthUrl}/health`, "gateway");

  log(`[ready] veadk-agent ${veadkHealth.chat_model}`);
  log(`[ready] gateway ${gatewayHealth.service}`);

  await testWebApp();
  const volcPcmAudio = await testVolcTts();
  await testVolcAsr(volcPcmAudio);
  await testVeadkText();
  await testVeadkVision();
  await testGatewayChat();
  await testGatewayImage();
  await testGatewayArkClaw();

  log("[done] smoke tests passed");
}

main().catch((error) => {
  process.stderr.write(`[fail] ${error.message}\n`);
  process.exitCode = 1;
});
