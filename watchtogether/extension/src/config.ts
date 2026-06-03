// ─── WatchTogether Extension Config ──────────────────────────────────────────
// All URLs are defined here and injected at build time by vite.config.ts.
// To switch environments, set the MODE when building:
//   npm run build          → uses local defaults below
//   npm run build:prod     → uses VITE_* env vars from .env.production

export const config = {
  API_BASE: (import.meta.env.VITE_API_BASE as string) ?? "http://localhost:8080/api",
  WS_BASE:  (import.meta.env.VITE_WS_BASE  as string) ?? "ws://localhost:8080/ws",
  APP_BASE: (import.meta.env.VITE_APP_BASE  as string) ?? "http://localhost:5173",
};
