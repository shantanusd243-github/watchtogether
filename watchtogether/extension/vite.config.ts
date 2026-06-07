import { defineConfig, loadEnv } from "vite";
import { resolve } from "path";
import { copyFileSync, mkdirSync, writeFileSync } from "fs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");

  const API_BASE = env.VITE_API_BASE ?? (mode === "development"
    ? "http://localhost:8080/api"
    : "https://watch-together-prod.up.railway.app/api");
  const WS_BASE = env.VITE_WS_BASE ?? (mode === "development"
    ? "ws://localhost:8080/ws"
    : "wss://watch-together-prod.up.railway.app/ws");
  const APP_BASE = env.VITE_APP_BASE ?? (mode === "development"
    ? "http://localhost:5173"
    : "https://watchtogether-zeta.vercel.app");

  return {
    // Inline all config values as compile-time constants so Rollup has nothing
    // to chunk — Chrome service workers cannot load relative ES module chunks.
    define: {
      __API_BASE__: JSON.stringify(API_BASE),
      __WS_BASE__:  JSON.stringify(WS_BASE),
      __APP_BASE__: JSON.stringify(APP_BASE),
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        input: {
          background: resolve(__dirname, "src/background/index.ts"),
          content:    resolve(__dirname, "src/content/index.ts"),
          popup:      resolve(__dirname, "src/popup/index.ts"),
        },
        output: {
          entryFileNames: "[name].js",
          assetFileNames: "assets/[name]-[hash][extname]",
          manualChunks: undefined,
          chunkFileNames: "[name].js",
          format: "es",
        },
        preserveEntrySignatures: "strict",
      },
      target: "es2022",
      minify: false,
      sourcemap: true,
    },
    plugins: [
      {
        name: "copy-public",
        closeBundle() {
          copyFileSync(resolve(__dirname, "public/manifest.json"), resolve(__dirname, "dist/manifest.json"));
          copyFileSync(resolve(__dirname, "public/popup.html"),    resolve(__dirname, "dist/popup.html"));
          writeFileSync(
            resolve(__dirname, "dist/config.json"),
            JSON.stringify({ VITE_API_BASE: API_BASE, VITE_WS_BASE: WS_BASE, VITE_APP_BASE: APP_BASE }, null, 2)
          );
          try { mkdirSync(resolve(__dirname, "dist/icons")); } catch {}
          console.log("✅ Extension assets copied to dist/");
        },
      },
    ],
  };
});
