import { defineConfig } from "vite";
import { resolve } from "path";
import { copyFileSync, mkdirSync } from "fs";

export default defineConfig({
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
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
        format: "es",
      },
    },
    target: "es2022",
    minify: false, // Easier debugging during development
    sourcemap: true,
  },
  plugins: [
    {
      name: "copy-public",
      closeBundle() {
        // Copy manifest
        copyFileSync(
          resolve(__dirname, "public/manifest.json"),
          resolve(__dirname, "dist/manifest.json")
        );
        // Copy popup HTML
        copyFileSync(
          resolve(__dirname, "public/popup.html"),
          resolve(__dirname, "dist/popup.html")
        );
        // Create icons directory (placeholder; real icons go here)
        try { mkdirSync(resolve(__dirname, "dist/icons")); } catch {}
        console.log("✅ Extension assets copied to dist/");
      },
    },
  ],
});
