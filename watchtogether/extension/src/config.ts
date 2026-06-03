// Centralized runtime config for extension
// Exports mutable bindings that can be overridden by a runtime config.json

declare const __VITE_API_BASE__: string | undefined;
declare const __VITE_WS_BASE__: string | undefined;
declare const __VITE_APP_BASE__: string | undefined;

export let API_BASE: string = typeof __VITE_API_BASE__ !== 'undefined' ? __VITE_API_BASE__ : 'http://localhost:8080/api';
export let WS_BASE: string  = typeof __VITE_WS_BASE__ !== 'undefined' ? __VITE_WS_BASE__ : 'ws://localhost:8080/ws';
export let APP_BASE: string = typeof __VITE_APP_BASE__ !== 'undefined' ? __VITE_APP_BASE__ : 'http://localhost:5173';

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
