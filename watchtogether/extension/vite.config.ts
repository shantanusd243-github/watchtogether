import { defineConfig, loadEnv } from "vite";
import { resolve } from "path";
import { copyFileSync, mkdirSync, writeFileSync } from "fs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");

  return {
    // URLs must be loaded from config.json at runtime, not baked into the build.
    // This ensures no production values are hardcoded in the source.
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        input: {
          background: resolve(__dirname, "src/background/index.ts"),
          content: resolve(__dirname, "src/content/index.ts"),
          popup: resolve(__dirname, "src/popup/index.ts"),
        },
        output: {
          entryFileNames: "[name].js",
          assetFileNames: "assets/[name]-[hash][extname]",
          // No chunks — everything inlined per entry file.
          // Chrome extensions cannot import relative chunk files.
          manualChunks: undefined,
          chunkFileNames: "[name].js",
          format: "es",
        },
        // Prevent Rollup from splitting shared code into chunks
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
          copyFileSync(resolve(__dirname, "public/popup.html"), resolve(__dirname, "dist/popup.html"));

          const runtimeConfig = {
            VITE_API_BASE: env.VITE_API_BASE ?? (mode === "development"
              ? "http://localhost:8080/api"
              : "https://watch-together-prod.up.railway.app/api"),
            VITE_WS_BASE: env.VITE_WS_BASE ?? (mode === "development"
              ? "ws://localhost:8080/ws"
              : "wss://watch-together-prod.up.railway.app/ws"),
            VITE_APP_BASE: env.VITE_APP_BASE ?? (mode === "development"
              ? "http://localhost:5173"
              : "https://watchtogether-zeta.vercel.app"),
          };
          writeFileSync(
            resolve(__dirname, "dist/config.json"),
            JSON.stringify(runtimeConfig, null, 2)
          );

          try { mkdirSync(resolve(__dirname, "dist/icons")); } catch {}
          console.log("✅ Extension assets copied to dist/");
        },
      },
    ],
  };
});
