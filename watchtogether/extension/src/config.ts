// Centralized runtime config for extension.
// All URLs are loaded from config.json at runtime — no hardcoded values.

export let API_BASE: string = '';
export let WS_BASE: string  = '';
export let APP_BASE: string = '';

export async function initConfig(): Promise<void> {
  try {
    const url = chrome.runtime.getURL('config.json');
    const res = await fetch(url);
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg.VITE_API_BASE) API_BASE = cfg.VITE_API_BASE;
    if (cfg.VITE_WS_BASE) WS_BASE = cfg.VITE_WS_BASE;
    if (cfg.VITE_APP_BASE) APP_BASE = cfg.VITE_APP_BASE;
    console.info('[WatchTogether] runtime config loaded');
  } catch (e) {
    console.info('[WatchTogether] no runtime config or failed to load', e);
  }
}
