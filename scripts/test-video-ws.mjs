import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import process from "node:process";

const gatewayUrl = process.env.GATEWAY_WS_URL || "ws://127.0.0.1:8787";
const origin = process.env.WEB_ORIGIN || "http://localhost:5173";

function testVideoEdit(text) {
  return new Promise((resolve, reject) => {
    const sessionId = randomUUID();
    const ws = new WebSocket(gatewayUrl, {
      headers: { origin }
    });
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        reject(new Error(`TIMEOUT: "${text}"`));
      }
    }, 15_000);

    const done = (pass, detail) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      ws.close();
      if (pass) {
        console.log(`  \u2713 "${text}" -> ${detail}`);
        resolve();
      } else {
        reject(new Error(`FAIL: "${text}" -> ${detail}`));
      }
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "session.start", sessionId }));
      ws.send(JSON.stringify({ type: "transcript.user", sessionId, text, source: "smoke-test" }));
    });

    ws.on("message", (buffer) => {
      const payload = JSON.parse(buffer.toString());
      if (payload.sessionId !== sessionId) return;

      if (payload.type === "capture.video.request") {
        done(false, "WRONG: routed to TAKE_VIDEO (capture.video.request)");
        return;
      }

      if (payload.type === "media.pick.request") {
        done(true, "media.pick.request (correct EDIT_VIDEO route)");
        return;
      }

      if (payload.type === "assistant.result" && payload.meta?.phase === "result") {
        done(true, `assistant.result: ${payload.speechText?.slice(0, 40) || "(no speech)"}`);
        return;
      }

      if (payload.type === "assistant.error") {
        done(false, `assistant.error: ${payload.message}`);
        return;
      }
    });

    ws.on("error", (error) => {
      done(false, `WebSocket error: ${error.message}`);
    });
  });
}

async function main() {
  console.log("Testing video edit intent routing via WebSocket...\n");

  const videoEditCases = [
    "帮我剪辑视频",
    "剪辑我录的视频",
    "剪一下录的视频",
    "帮我剪一下这个视频",
  ];

  let passed = 0;
  let failed = 0;

  for (const text of videoEditCases) {
    try {
      await testVideoEdit(text);
      passed++;
    } catch (error) {
      console.log(`  \u2717 ${error.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();