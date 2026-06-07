// ─── Runtime config ────────────────────────────────────────────────────────
// __API_BASE__, __WS_BASE__, __APP_BASE__ are replaced at build time by
// vite.config.ts `define`. No shared module chunk is emitted.
// initConfig() is kept as a no-op for backward compatibility.

declare const __API_BASE__: string;
declare const __WS_BASE__: string;
declare const __APP_BASE__: string;

export const API_BASE: string = __API_BASE__;
export const WS_BASE:  string = __WS_BASE__;
export const APP_BASE: string = __APP_BASE__;

export async function initConfig(): Promise<void> {
  // No-op — values are baked in at build time via vite define.
  // Kept so callers don't need to change.
}
