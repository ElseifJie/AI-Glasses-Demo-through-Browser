#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT_DIR"

echo "[check] Node.js syntax"
node --check apps/gateway/src/server.mjs
node --check apps/gateway/src/arkclaw-client.mjs
node --check apps/gateway/src/intent-rewriter.mjs
node --check apps/gateway/src/tos-client.mjs
node --check apps/gateway/src/video-editing.mjs
node --check apps/gateway/src/volc-asr-client.mjs
node --check apps/gateway/src/volc-tts-client.mjs
node --check apps/glasses-web/src/main.js
node --check apps/glasses-web/src/media-library.js
node --check packages/shared/src/protocol.mjs
node --check scripts/smoke-test.mjs
node --check scripts/test-video-intent.mjs
node --check scripts/test-video-ws.mjs

echo "[check] Python syntax"
python3 -m py_compile apps/veadk-agent/app.py

echo "[check] Intent routing"
node scripts/test-video-intent.mjs

echo "[done] repository checks passed"
