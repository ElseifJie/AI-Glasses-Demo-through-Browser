import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  envDir: resolve(__dirname, "../.."),
  server: {
    host: "127.0.0.1",
    port: 5173
  }
});
