import path from "node:path";
import { randomUUID } from "node:crypto";
import { TosClient } from "@volcengine/tos-sdk";

function trimSlashes(value = "") {
  return value.replace(/^\/+|\/+$/g, "");
}

function parseTosPath(input) {
  const value = String(input || "").trim();
  const match = value.match(/^tos:\/\/([^/]+)\/?(.*)$/i);
  if (!match) {
    throw new Error(`Invalid TOS path: ${input}`);
  }

  return {
    bucket: match[1],
    key: trimSlashes(match[2] || "")
  };
}

function joinTosKey(prefix, ...segments) {
  return [prefix, ...segments]
    .map((item) => trimSlashes(item || ""))
    .filter(Boolean)
    .join("/");
}

function guessExtension(fileName, fallback = ".webm") {
  const ext = path.extname(fileName || "").trim();
  return ext || fallback;
}

export class GatewayTosClient {
  constructor(env) {
    this.bucket = env.TOS_BUCKET || "";
    this.region = env.TOS_REGION || "";
    this.endpoint = env.TOS_ENDPOINT || "";
    this.originPrefix = env.TOS_ORIGIN_VIDEO_PREFIX || "";
    this.outputPrefix = env.TOS_OUTPUT_VIDEO_PREFIX || "";

    this.client = new TosClient({
      accessKeyId: env.TOS_ACCESS_KEY_ID || "",
      accessKeySecret: env.TOS_ACCESS_KEY_SECRET || "",
      region: this.region,
      endpoint: this.endpoint,
      bucket: this.bucket
    });
  }

  isConfigured() {
    return Boolean(
      this.bucket &&
      this.region &&
      this.endpoint &&
      this.originPrefix &&
      this.outputPrefix
    );
  }

  assertConfigured() {
    if (!this.isConfigured()) {
      throw new Error("TOS is not fully configured for video editing.");
    }
  }

  buildOriginObjectKey(sessionId, fileName) {
    const prefix = parseTosPath(this.originPrefix);
    const ext = guessExtension(fileName);
    return joinTosKey(prefix.key, sessionId, `${Date.now()}-${randomUUID()}${ext}`);
  }

  buildOutputFolderKey(sessionId, taskId) {
    const prefix = parseTosPath(this.outputPrefix);
    return joinTosKey(prefix.key, sessionId, taskId);
  }

  toTosUri(key, bucket = this.bucket) {
    return `tos://${bucket}/${trimSlashes(key)}`;
  }

  async uploadVideoBuffer({ buffer, fileName, contentType, sessionId }) {
    this.assertConfigured();
    const prefix = parseTosPath(this.originPrefix);
    const key = this.buildOriginObjectKey(sessionId, fileName);

    await this.client.putObject({
      bucket: prefix.bucket,
      key,
      body: buffer,
      contentType: contentType || "video/mp4"
    });

    return {
      bucket: prefix.bucket,
      key,
      tosPath: this.toTosUri(key, prefix.bucket)
    };
  }

  buildOutputTosPath(sessionId, taskId) {
    this.assertConfigured();
    const prefix = parseTosPath(this.outputPrefix);
    const key = this.buildOutputFolderKey(sessionId, taskId);
    return `${this.toTosUri(key, prefix.bucket)}/`;
  }

  async listOutputVideos(sessionId, taskId) {
    this.assertConfigured();
    const prefix = parseTosPath(this.outputPrefix);
    const keyPrefix = `${this.buildOutputFolderKey(sessionId, taskId)}/`;
    const { data } = await this.client.listObjects({
      bucket: prefix.bucket,
      prefix: keyPrefix,
      maxKeys: 100
    });

    const contents = (data?.Contents || [])
      .filter((item) => item.Key && !item.Key.endsWith("/"))
      .sort((a, b) => Date.parse(b.LastModified) - Date.parse(a.LastModified));

    return contents.map((item) => ({
      bucket: prefix.bucket,
      key: item.Key,
      tosPath: this.toTosUri(item.Key, prefix.bucket),
      fileName: item.Key.split("/").pop() || item.Key,
      downloadUrl: this.client.getPreSignedUrl({
        bucket: prefix.bucket,
        key: item.Key,
        method: "GET",
        expires: 3600
      })
    }));
  }
}

export { parseTosPath, joinTosKey };
