import { defineConfig, loadEnv } from "vite";
import { resolve } from "path";
import { copyFileSync, mkdirSync } from "fs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");

  return {
    // Inject env vars as compile-time constants so they get inlined
    // into each bundle — no runtime chunk imports which break extensions.
    define: {
      "__VITE_API_BASE__": JSON.stringify(env.VITE_API_BASE ?? "http://localhost:8080/api"),
      "__VITE_WS_BASE__":  JSON.stringify(env.VITE_WS_BASE  ?? "ws://localhost:8080/ws"),
      "__VITE_APP_BASE__": JSON.stringify(env.VITE_APP_BASE  ?? "http://localhost:5173"),
    },
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
          copyFileSync(resolve(__dirname, "public/popup.html"),    resolve(__dirname, "dist/popup.html"));
          try { mkdirSync(resolve(__dirname, "dist/icons")); } catch {}
          console.log("✅ Extension assets copied to dist/");
        },
      },
    ],
  };
});
