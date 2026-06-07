import type { InternalMessage, WatchEvent } from "../types/index";

// ─── State ────────────────────────────────────────────────────────────────────
let videoEl: HTMLVideoElement | null = null;
let isApplyingRemote = false;
let detectTimer: ReturnType<typeof setInterval> | null = null;
let lastReportedTime = -1;
let lastReportedPlaying: boolean | null = null;
let lastReportedRate = 1;
const SEEK_DEBOUNCE_MS = 200;
let seekDebounce: ReturnType<typeof setTimeout> | null = null;

// After a local seek, suppress heartbeat corrections briefly to prevent
// ping-pong override loops between users.
const POST_SEEK_SETTLE_MS = 5000;
let lastLocalSeekAt = 0;

// Suppress outbound events for a short window after remote application so
// Netflix / HTML5 player callbacks do not bounce the event back to the peer.
let outboundSuppressedUntil = 0;
const REMOTE_APPLY_SUPPRESSION_MS = 1500;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sendToBackground(msg: InternalMessage): void {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function log(...args: any[]): void {
  console.log("[WatchTogether Content]", ...args);
}

function shouldIgnoreLocalEvent(): boolean {
  return isApplyingRemote || Date.now() < outboundSuppressedUntil || !videoEl;
}

function suppressOutbound(ms = REMOTE_APPLY_SUPPRESSION_MS): void {
  outboundSuppressedUntil = Math.max(outboundSuppressedUntil, Date.now() + ms);
}

function isVisibleElement(el: Element): boolean {
  const node = el as HTMLElement;
  const rect = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0"
  );
}

function dispatchKeyboardSequence(doc: Document, key: string, code: string): void {
  const target = (doc.activeElement as HTMLElement | null) ?? doc.body ?? doc.documentElement;
  if (!target) return;

  const init: KeyboardEventInit = {
    key,
    code,
    bubbles: true,
    cancelable: true,
    composed: true,
  };

  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keypress", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
}

function findClickableControl(doc: Document, kind: "play" | "pause"): HTMLElement | null {
  const keywords = kind === "play" ? ["play", "resume"] : ["pause"];
  const candidates = Array.from(
    doc.querySelectorAll<HTMLElement>(
      "button, [role='button'], [aria-label], [title], [data-uia]"
    )
  );

  for (const el of candidates) {
    const label = [
      el.getAttribute("aria-label") ?? "",
      el.getAttribute("title") ?? "",
      el.getAttribute("data-uia") ?? "",
      el.textContent ?? "",
    ]
      .join(" ")
      .toLowerCase();

    if (!keywords.some((k) => label.includes(k))) continue;
    if (!isVisibleElement(el)) continue;
    return el;
  }

  return null;
}

function clickFallbackControl(video: HTMLVideoElement, kind: "play" | "pause"): boolean {
  const doc = video.ownerDocument;
  const control = findClickableControl(doc, kind);
  if (control) {
    control.click();
    return true;
  }
  return false;
}

function getVideoRootDocuments(): Document[] {
  const docs: Document[] = [document];

  try {
    for (const frame of Array.from(window.frames)) {
      try {
        if (frame.document && !docs.includes(frame.document)) {
          docs.push(frame.document);
        }
      } catch {
        // Cross-origin iframe — ignore.
      }
    }
  } catch {
    // no frames
  }

  return docs;
}

function collectVideosFromRoot(root: ParentNode): HTMLVideoElement[] {
  const videos = Array.from(root.querySelectorAll<HTMLVideoElement>("video"));

  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    if (el.shadowRoot) {
      videos.push(...collectVideosFromRoot(el.shadowRoot));
    }
  }

  return videos;
}

function nativeSetCurrentTime(video: HTMLVideoElement, t: number): void {
  const desc =
    Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "currentTime") ??
    Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");

  if (desc?.set) {
    desc.set.call(video, t);
  } else {
    video.currentTime = t;
  }
}

function nativeSetPlaybackRate(video: HTMLVideoElement, r: number): void {
  const desc =
    Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "playbackRate") ??
    Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "playbackRate");

  if (desc?.set) {
    desc.set.call(video, r);
  } else {
    video.playbackRate = r;
  }
}

// Netflix and some players block programmatic play()/pause() from extensions.
// We try the native call first, then fall back to visible player controls and
// keyboard shortcuts.
async function nativePlay(video: HTMLVideoElement): Promise<void> {
  if (!video.paused) return;

  try {
    await video.play();
    await new Promise((r) => setTimeout(r, 200));
    if (!video.paused) return;
  } catch {
    // fall through to fallbacks
  }

  log("play() blocked — trying player-control fallback");
  if (clickFallbackControl(video, "play")) {
    await new Promise((r) => setTimeout(r, 150));
    if (!video.paused) return;
  }

  dispatchKeyboardSequence(video.ownerDocument, " ", "Space");
}

function nativePause(video: HTMLVideoElement): void {
  if (video.paused) return;

  try {
    video.pause();
  } catch {
    // fall through to fallbacks
  }

  setTimeout(() => {
    if (video.paused) return;

    log("pause() blocked — trying player-control fallback");
    if (clickFallbackControl(video, "pause")) {
      return;
    }

    dispatchKeyboardSequence(video.ownerDocument, " ", "Space");
  }, 100);
}

// ─── Video Detection ──────────────────────────────────────────────────────────
function findVideo(): HTMLVideoElement | null {
  const docs = getVideoRootDocuments();

  for (const doc of docs) {
    const videos = collectVideosFromRoot(doc);
    if (!videos.length) continue;

    const best =
      videos.find((v) => (v.readyState >= 2 && !v.paused) || v.currentTime > 0) ||
      videos.find((v) => v.readyState >= 2) ||
      videos.find((v) => v.readyState >= 1) ||
      videos.find((v) => v.src !== "" || v.currentSrc !== "") ||
      videos[0];

    if (best) return best;
  }

  return null;
}

function startDetection(): void {
  if (detectTimer) return;
  detectTimer = setInterval(() => {
    const found = findVideo();
    if (found && found !== videoEl) attachListeners(found);
  }, 1000);
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
function attachListeners(video: HTMLVideoElement): void {
  if (videoEl) detachListeners();
  videoEl = video;
  lastReportedTime = video.currentTime;
  lastReportedPlaying = !video.paused;
  lastReportedRate = video.playbackRate;

  log("✅ Attached to video — src:", video.src || video.currentSrc || "(blob)");

  video.addEventListener("play", onPlay);
  video.addEventListener("pause", onPause);
  video.addEventListener("seeking", onSeeking);
  video.addEventListener("ratechange", onRateChange);
  video.addEventListener("timeupdate", onTimeUpdate);

  // Inject floating chat button once video is found
  maybeInjectUI();
}

function detachListeners(): void {
  if (!videoEl) return;
  videoEl.removeEventListener("play", onPlay);
  videoEl.removeEventListener("pause", onPause);
  videoEl.removeEventListener("seeking", onSeeking);
  videoEl.removeEventListener("ratechange", onRateChange);
  videoEl.removeEventListener("timeupdate", onTimeUpdate);
  videoEl = null;
}

// ─── Local Event Handlers ─────────────────────────────────────────────────────
function onPlay(): void {
  if (shouldIgnoreLocalEvent()) return;
  if (!videoEl) return;

  log("Local PLAY at", videoEl.currentTime);
  sendToBackground({
    type: "VIDEO_EVENT",
    payload: { type: "PLAY", currentTime: videoEl.currentTime, playing: true } as Partial<WatchEvent>,
  });
  lastReportedPlaying = true;
  lastReportedTime = videoEl.currentTime;
}

function onPause(): void {
  if (shouldIgnoreLocalEvent()) return;
  if (!videoEl) return;
  if (videoEl.seeking) return; // transient pause during seek — ignore

  log("Local PAUSE at", videoEl.currentTime);
  sendToBackground({
    type: "VIDEO_EVENT",
    payload: { type: "PAUSE", currentTime: videoEl.currentTime, playing: false } as Partial<WatchEvent>,
  });
  lastReportedPlaying = false;
  lastReportedTime = videoEl.currentTime;
}

function onSeeking(): void {
  if (shouldIgnoreLocalEvent()) return;
  if (!videoEl) return;

  lastLocalSeekAt = Date.now();
  if (seekDebounce) clearTimeout(seekDebounce);

  seekDebounce = setTimeout(() => {
    if (!videoEl || shouldIgnoreLocalEvent()) return;

    log("Local SEEK to", videoEl.currentTime);
    sendToBackground({
      type: "VIDEO_EVENT",
      payload: { type: "SEEK", currentTime: videoEl.currentTime, playing: !videoEl.paused } as Partial<WatchEvent>,
    });
    lastReportedTime = videoEl.currentTime;
  }, SEEK_DEBOUNCE_MS);
}

function onRateChange(): void {
  if (shouldIgnoreLocalEvent()) return;
  if (!videoEl) return;

  const rate = videoEl.playbackRate;
  if (Math.abs(rate - lastReportedRate) < 0.01) return;

  lastReportedRate = rate;
  log("Local SPEED change to", rate);
  sendToBackground({
    type: "VIDEO_EVENT",
    payload: { type: "SPEED", currentTime: videoEl.currentTime, playbackRate: rate } as Partial<WatchEvent>,
  });
}

function onTimeUpdate(): void {
  if (!videoEl) return;
  const now = videoEl.currentTime;
  const playing = !videoEl.paused;
  if (Math.abs(now - lastReportedTime) < 2 && playing === lastReportedPlaying) return;
  lastReportedTime = now;
  lastReportedPlaying = playing;
}

// ─── Remote Event Application ─────────────────────────────────────────────────
// Latency compensation: sender stamps event.timestamp (epoch ms).
// Receiver adds the transit time to currentTime so both are truly in sync.
function compensatedTime(event: WatchEvent): number {
  if (!event.currentTime) return 0;
  if (!event.timestamp || event.type === "PAUSE") return event.currentTime;
  const transitSec = (Date.now() - event.timestamp) / 1000;
  // Only compensate if playing and transit is reasonable (< 10s means valid)
  if (event.playing === false) return event.currentTime;
  const clamped = Math.min(Math.max(transitSec, 0), 10);
  return event.currentTime + clamped * (event.playbackRate ?? 1);
}

async function applyRemoteEvent(event: WatchEvent): Promise<void> {
  if (!videoEl) {
    log("No video element to apply event to");
    return;
  }

  isApplyingRemote = true;
  suppressOutbound();

  try {
    switch (event.type) {
      case "PLAY": {
        const target = compensatedTime(event);
        if (target) {
          const diff = Math.abs(videoEl.currentTime - target);
          if (diff > 0.5) nativeSetCurrentTime(videoEl, target);
        }
        await nativePlay(videoEl);
        break;
      }

      case "PAUSE": {
        if (event.currentTime !== undefined) {
          const diff = Math.abs(videoEl.currentTime - event.currentTime);
          if (diff > 0.5) nativeSetCurrentTime(videoEl, event.currentTime);
        }
        nativePause(videoEl);
        break;
      }

      case "SEEK": {
        const target = compensatedTime(event);
        if (target) nativeSetCurrentTime(videoEl, target);
        break;
      }

      case "SPEED": {
        if (event.playbackRate !== undefined) {
          log("Remote SPEED change to", event.playbackRate);
          nativeSetPlaybackRate(videoEl, event.playbackRate);
        }
        break;
      }

      case "HEARTBEAT": {
        if (event.currentTime === undefined) break;

        const msSinceLocalSeek = Date.now() - lastLocalSeekAt;
        if (msSinceLocalSeek < POST_SEEK_SETTLE_MS) {
          log(`Heartbeat suppressed — ${msSinceLocalSeek}ms since local seek, still settling`);
          break;
        }

        const target = compensatedTime(event);
        const diff = Math.abs(videoEl.currentTime - target);
        if (diff > 1.0) {
          log(`Heartbeat drift ${diff.toFixed(2)}s — correcting to ${target.toFixed(2)}s`);
          nativeSetCurrentTime(videoEl, target);
        }

        if (event.playbackRate !== undefined && Math.abs(videoEl.playbackRate - event.playbackRate) > 0.01) {
          nativeSetPlaybackRate(videoEl, event.playbackRate);
        }

        if (event.playing !== undefined) {
          if (event.playing && videoEl.paused) await nativePlay(videoEl);
          else if (!event.playing && !videoEl.paused) nativePause(videoEl);
        }
        break;
      }
    }
  } finally {
    setTimeout(() => {
      isApplyingRemote = false;
    }, 100);
  }
}

// ─── Current State Reporter ───────────────────────────────────────────────────
function getCurrentState(): { currentTime: number; playing: boolean; playbackRate: number; hasVideo: boolean } {
  if (!videoEl) return { currentTime: 0, playing: false, playbackRate: 1, hasVideo: false };
  return {
    currentTime: videoEl.currentTime,
    playing: !videoEl.paused,
    playbackRate: videoEl.playbackRate,
    hasVideo: true,
  };
}

// ─── Message Listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(
  (message: InternalMessage, _sender, sendResponse) => {
    log("📨 Message received:", message.type, message.payload);
    switch (message.type) {
      case "APPLY_REMOTE_EVENT":
        applyRemoteEvent(message.payload as WatchEvent);
        sendResponse({ ok: true });
        break;

      case "GET_STATE": {
        const s = getCurrentState();
        log("📤 Reporting state:", s);
        sendToBackground({ type: "APPLY_REMOTE_EVENT", payload: s });
        sendResponse(s);
        break;
      }

      case "TRIGGER_JOIN": {
        // Only let the top frame trigger the join flow to avoid duplicate joins
        // when the script is injected into multiple frames.
        if (window.top !== window) {
          sendResponse({ ok: true });
          break;
        }
        sendToBackground({
          type: "JOIN_ROOM",
          payload: {
            roomId: message.payload.roomId,
            sourceTabId: message.payload.sourceTabId,
          },
        });
        sendResponse({ ok: true });
        break;
      }

      case "CHAT_RECEIVED": {
        const msg = message.payload as import("../types/index").ChatMessage;
        showChatOverlay(msg);
        sendResponse({ ok: true });
        break;
      }

      case "START_VOICE": {
        startVoiceRecognition();
        sendResponse({ ok: true });
        break;
      }

      case "STOP_VOICE": {
        stopVoiceRecognition();
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: "Unknown type" });
    }
    return true;
  }
);

// ─── Chat Overlay & Floating Button ──────────────────────────────────────────

let overlayContainer: HTMLDivElement | null = null;
let chatPanelEl: HTMLDivElement | null = null;
let chatPanelVisible = false;
const OVERLAY_Z = "2147483640";

function ensureOverlayContainer(): HTMLDivElement {
  if (overlayContainer && overlayContainer.isConnected) return overlayContainer;
  overlayContainer = document.createElement("div");
  overlayContainer.id = "__wt_overlay__";
  overlayContainer.style.cssText = `
    position: fixed; bottom: 80px; left: 20px;
    z-index: ${OVERLAY_Z}; pointer-events: none;
    display: flex; flex-direction: column; gap: 8px;
    max-width: 320px;
  `;
  document.documentElement.appendChild(overlayContainer);
  return overlayContainer;
}

function showChatOverlay(msg: import("../types/index").ChatMessage): void {
  const container = ensureOverlayContainer();
  const bubble = document.createElement("div");
  bubble.style.cssText = `
    background: rgba(10,10,20,0.82);
    backdrop-filter: blur(8px);
    border: 1px solid rgba(124,106,247,0.35);
    border-radius: 12px;
    padding: 8px 12px;
    color: #e8e8f0;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    line-height: 1.4;
    pointer-events: none;
    animation: __wt_fadein__ 0.2s ease-out;
    max-width: 300px;
    word-break: break-word;
  `;

  const nameEl = document.createElement("span");
  nameEl.style.cssText = "font-weight:700;color:#4ecdc4;margin-right:6px;font-size:11px;";
  nameEl.textContent = msg.displayName + ":";

  const bodyEl = document.createElement("span");
  if (msg.isGif) {
    const img = document.createElement("img");
    img.src = msg.text;
    img.style.cssText = "max-width:200px;max-height:120px;border-radius:8px;display:block;margin-top:4px;";
    bubble.appendChild(nameEl);
    bubble.appendChild(img);
  } else {
    bodyEl.textContent = msg.text;
    bubble.appendChild(nameEl);
    bubble.appendChild(bodyEl);
  }

  // Inject keyframes once
  if (!document.getElementById("__wt_styles__")) {
    const style = document.createElement("style");
    style.id = "__wt_styles__";
    style.textContent = `
      @keyframes __wt_fadein__ { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
      @keyframes __wt_fadeout__ { from{opacity:1} to{opacity:0} }
    `;
    document.head.appendChild(style);
  }

  container.appendChild(bubble);
  setTimeout(() => {
    bubble.style.animation = "__wt_fadeout__ 0.4s ease-out forwards";
    setTimeout(() => bubble.remove(), 400);
  }, 4000);
}

function buildChatPanel(): HTMLDivElement {
  const panel = document.createElement("div");
  panel.id = "__wt_chat_panel__";
  panel.style.cssText = `
    position: fixed; bottom: 80px; right: 20px;
    width: 300px; height: 380px;
    background: rgba(10,10,20,0.92);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(124,106,247,0.4);
    border-radius: 16px;
    z-index: ${OVERLAY_Z};
    display: flex; flex-direction: column;
    font-family: system-ui, sans-serif;
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  `;

  // Header
  const header = document.createElement("div");
  header.style.cssText = "padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:space-between;";
  header.innerHTML = `<span style="color:#e8e8f0;font-weight:700;font-size:13px;">💬 Room Chat</span>`;
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.style.cssText = "background:none;border:none;color:#6060a0;cursor:pointer;font-size:14px;padding:2px 4px;";
  closeBtn.addEventListener("click", () => toggleChatPanel());
  header.appendChild(closeBtn);
  panel.appendChild(header);

  // Messages area
  const msgs = document.createElement("div");
  msgs.id = "__wt_chat_msgs__";
  msgs.style.cssText = "flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;";
  panel.appendChild(msgs);

  // GIF search row
  const gifRow = document.createElement("div");
  gifRow.style.cssText = "padding:6px 10px;border-top:1px solid rgba(255,255,255,0.06);display:flex;gap:6px;";
  const gifInput = document.createElement("input");
  gifInput.placeholder = "Search GIF…";
  gifInput.style.cssText = "flex:1;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:5px 8px;color:#e8e8f0;font-size:11px;outline:none;";
  const gifBtn = document.createElement("button");
  gifBtn.textContent = "GIF";
  gifBtn.style.cssText = "background:rgba(124,106,247,0.3);border:1px solid rgba(124,106,247,0.5);border-radius:8px;color:#a99fff;cursor:pointer;font-size:11px;font-weight:700;padding:4px 8px;";
  gifRow.appendChild(gifInput);
  gifRow.appendChild(gifBtn);
  panel.appendChild(gifRow);

  // GIF results area (hidden by default)
  const gifResults = document.createElement("div");
  gifResults.id = "__wt_gif_results__";
  gifResults.style.cssText = "display:none;padding:6px 10px;max-height:100px;overflow-y:auto;display:none;flex-wrap:wrap;gap:4px;border-top:1px solid rgba(255,255,255,0.06);";
  panel.appendChild(gifResults);

  // Input row
  const inputRow = document.createElement("div");
  inputRow.style.cssText = "padding:8px 10px;border-top:1px solid rgba(255,255,255,0.08);display:flex;gap:6px;align-items:center;";
  const textInput = document.createElement("input");
  textInput.id = "__wt_chat_input__";
  textInput.placeholder = "Message or emoji…";
  textInput.style.cssText = "flex:1;min-width:0;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:8px 10px;color:#e8e8f0;font-size:13px;outline:none;";
  const emojiBtn = document.createElement("button");
  emojiBtn.textContent = "😊";
  emojiBtn.title = "Emoji";
  emojiBtn.style.cssText = "flex-shrink:0;width:34px;height:34px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);border-radius:10px;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;";
  const micBtn = document.createElement("button");
  micBtn.id = "__wt_mic_btn__";
  micBtn.textContent = "🎤";
  micBtn.title = "Voice input";
  micBtn.style.cssText = "flex-shrink:0;width:34px;height:34px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#fff;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;";
  micBtn.addEventListener("click", () => {
    voiceActive ? stopVoiceRecognition() : startVoiceRecognition();
  });
  const sendBtn = document.createElement("button");
  sendBtn.textContent = "➤";
  sendBtn.style.cssText = "flex-shrink:0;width:34px;height:34px;background:linear-gradient(135deg,#7c6af7,#4ecdc4);border:none;border-radius:10px;color:#fff;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;";
  inputRow.appendChild(textInput);
  inputRow.appendChild(emojiBtn);
  inputRow.appendChild(micBtn);
  inputRow.appendChild(sendBtn);
  panel.appendChild(inputRow);

  // Emoji picker (inline grid, common emojis)
  const EMOJIS = ["😂","❤️","😍","🤣","😊","🙏","💕","😭","😘","👍","😁","🔥","💔","💖","😢","🤔","😎","😩","🥺","😏","💪","🙄","😜","🎉","🥳","😤","🙃","😅","😆","🤩","👏","😋","✨","🤯","😳","🤗","💯","🎶","👀","😴","😈","👻","🤦","🤷","💀","🥰","😻","🫶","🫠","🫡","💬","🗣️","🎬","🍿","🎥","📺","🎮"];
  const emojiGrid = document.createElement("div");
  emojiGrid.style.cssText = "display:none;position:absolute;bottom:60px;right:10px;width:240px;background:rgba(10,10,20,0.96);border:1px solid rgba(124,106,247,0.4);border-radius:12px;padding:8px;display:none;flex-wrap:wrap;gap:4px;z-index:2147483641;max-height:160px;overflow-y:auto;";
  EMOJIS.forEach(em => {
    const btn = document.createElement("button");
    btn.textContent = em;
    btn.style.cssText = "background:none;border:none;cursor:pointer;font-size:20px;padding:2px;border-radius:4px;line-height:1;";
    btn.addEventListener("click", () => {
      textInput.value += em;
      textInput.focus();
    });
    emojiGrid.appendChild(btn);
  });
  panel.style.position = "fixed"; // ensure relative positioning works
  panel.appendChild(emojiGrid);

  emojiBtn.addEventListener("click", () => {
    emojiGrid.style.display = emojiGrid.style.display === "none" ? "flex" : "none";
  });

  // Send on Enter or button click
  const doSend = () => {
    const text = textInput.value.trim();
    if (!text) return;
    sendToBackground({ type: "SEND_CHAT", payload: { text, isGif: false } });
    textInput.value = "";
  };
  sendBtn.addEventListener("click", doSend);
  textInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSend(); });

  // GIF search via Tenor public API (no key required for basic usage)
  gifBtn.addEventListener("click", async () => {
    const q = gifInput.value.trim();
    if (!q) return;
    gifResults.style.display = "flex";
    gifResults.innerHTML = "<span style='color:#6060a0;font-size:11px;padding:4px;'>Searching…</span>";
    try {
      const res = await fetch(`https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}&key=AIzaSyB_63SFMSXX5k-wLKQtmVMPZe6nhqw&limit=8&media_filter=gif`);
      const data = await res.json();
      gifResults.innerHTML = "";
      const results = data.results || [];
      if (!results.length) {
        // Fallback to Giphy public API
        const g = await fetch(`https://api.giphy.com/v1/gifs/search?api_key=0UTRbFtkMxAplrohufYco1HcGWrNyO&q=${encodeURIComponent(q)}&limit=8&rating=g`);
        const gd = await g.json();
        (gd.data || []).forEach((r: any) => {
          const url = r.images?.fixed_height_small?.url || r.images?.original?.url;
          if (!url) return;
          appendGifResult(url, gifResults, gifInput);
        });
      } else {
        results.forEach((r: any) => {
          const url = r.media_formats?.gif?.url || r.media_formats?.tinygif?.url;
          if (!url) return;
          appendGifResult(url, gifResults, gifInput);
        });
      }
      if (!gifResults.children.length) gifResults.innerHTML = "<span style='color:#6060a0;font-size:11px;padding:4px;'>No results</span>";
    } catch {
      gifResults.innerHTML = "<span style='color:#ff4757;font-size:11px;padding:4px;'>Search failed</span>";
    }
  });
  gifInput.addEventListener("keydown", (e) => { if (e.key === "Enter") gifBtn.click(); });

  return panel;
}

function appendGifResult(url: string, container: HTMLElement, inputToClear: HTMLInputElement): void {
  const img = document.createElement("img");
  img.src = url;
  img.style.cssText = "width:80px;height:60px;object-fit:cover;border-radius:6px;cursor:pointer;";
  img.addEventListener("click", () => {
    sendToBackground({ type: "SEND_CHAT", payload: { text: url, isGif: true } });
    container.style.display = "none";
    inputToClear.value = "";
  });
  container.appendChild(img);
}

function appendMessageToPanel(msg: import("../types/index").ChatMessage): void {
  const msgs = document.getElementById("__wt_chat_msgs__");
  if (!msgs) return;

  const row = document.createElement("div");
  row.style.cssText = "display:flex;flex-direction:column;gap:2px;";

  const nameEl = document.createElement("span");
  nameEl.style.cssText = "font-size:10px;font-weight:700;color:#4ecdc4;";
  nameEl.textContent = msg.displayName;

  const bodyEl = document.createElement("div");
  bodyEl.style.cssText = "background:rgba(255,255,255,0.06);border-radius:10px;padding:6px 10px;max-width:240px;word-break:break-word;color:#e8e8f0;font-size:12px;";

  if (msg.isGif) {
    const img = document.createElement("img");
    img.src = msg.text;
    img.style.cssText = "max-width:200px;max-height:130px;border-radius:8px;display:block;";
    bodyEl.appendChild(img);
  } else {
    bodyEl.textContent = msg.text;
  }

  row.appendChild(nameEl);
  row.appendChild(bodyEl);
  msgs.appendChild(row);
  msgs.scrollTop = msgs.scrollHeight;
}

function toggleChatPanel(): void {
  if (chatPanelVisible) {
    chatPanelEl?.remove();
    chatPanelVisible = false;
  } else {
    chatPanelEl = buildChatPanel();
    document.documentElement.appendChild(chatPanelEl);
    chatPanelVisible = true;
  }
}

// Floating chat button — injected into the page
function injectFloatingButton(): void {
  if (document.getElementById("__wt_fab__")) return;
  const fab = document.createElement("button");
  fab.id = "__wt_fab__";
  fab.title = "WatchTogether Chat";
  fab.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;
  fab.style.cssText = `
    position: fixed; bottom: 20px; right: 20px;
    width: 48px; height: 48px;
    background: linear-gradient(135deg, #7c6af7, #4ecdc4);
    border: none; border-radius: 50%; cursor: pointer;
    z-index: ${OVERLAY_Z};
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 4px 16px rgba(124,106,247,0.5);
    transition: transform 0.15s;
  `;
  fab.addEventListener("mouseenter", () => { fab.style.transform = "scale(1.1)"; });
  fab.addEventListener("mouseleave", () => { fab.style.transform = "scale(1)"; });
  fab.addEventListener("click", toggleChatPanel);
  document.documentElement.appendChild(fab);
}

// Also handle incoming chat messages in the panel
const _origOnMessage = chrome.runtime.onMessage;
chrome.runtime.onMessage.addListener(
  (message: import("../types/index").InternalMessage) => {
    if (message.type === "CHAT_RECEIVED") {
      appendMessageToPanel(message.payload);
    }
  }
);

// Inject button once we know there's a room (background sends CHAT_RECEIVED or APPLY_REMOTE_EVENT)
// Simple approach: inject after video is found
function maybeInjectUI(): void {
  injectFloatingButton();
  ensureOverlayContainer();
}

// ─── Init ─────────────────────────────────────────────────────────────────────
const initialVideo = findVideo();
if (initialVideo) {
  attachListeners(initialVideo);
} else {
  startDetection();
}

const observer = new MutationObserver(() => {
  const found = findVideo();
  if (found && found !== videoEl) attachListeners(found);
});

if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
}

log("Content script initialized on", window.location.href);

// ─── Voice Recognition ───────────────────────────────────────────────────────
let voiceActive = false;

function createAndStartRecognition(): void {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SR || !voiceActive) return;

  // Fresh instance every sentence — prevents transcript accumulation
  const rec = new SR();
  rec.continuous = false;      // auto fires isFinal after each utterance
  rec.interimResults = true;
  rec.lang = "en-IN";          // Hindi/Marathi in Roman script

  rec.onresult = (event: any) => {
    let interim = "";
    let finalText = "";
    for (let i = 0; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += t;
      else interim += t;
    }
    // Update overlay chat input with live interim text
    const overlayInput = document.getElementById("__wt_chat_input__") as HTMLInputElement | null;
    if (overlayInput && interim) overlayInput.value = interim;

    if (interim) {
      chrome.runtime.sendMessage({
        type: "VOICE_TRANSCRIPT",
        payload: { text: interim, isFinal: false },
      }).catch(() => {});
    }
    if (finalText.trim()) {
      if (overlayInput) overlayInput.value = "";

      const lower = finalText.trim().toLowerCase();

      // Voice commands — don't send as chat, control video directly
      const isPauseCmd = /\b(pause|stop)\b.*\b(video|movie|film)\b|\b(video|movie|film)\b.*\b(pause|stop)\b/.test(lower);
      const isPlayCmd = /\b(play|resume|start)\b.*\b(video|movie|film)\b|\b(video|movie|film)\b.*\b(play|resume|start)\b/.test(lower);

      if (isPauseCmd && videoEl) {
        log("Voice command: PAUSE");
        nativePause(videoEl);
        sendToBackground({
          type: "VIDEO_EVENT",
          payload: { type: "PAUSE", currentTime: videoEl.currentTime, playing: false },
        });
        return;
      }

      if (isPlayCmd && videoEl) {
        log("Voice command: PLAY");
        nativePlay(videoEl);
        sendToBackground({
          type: "VIDEO_EVENT",
          payload: { type: "PLAY", currentTime: videoEl.currentTime, playing: true },
        });
        return;
      }

      // Not a command — send as chat message
      chrome.runtime.sendMessage({
        type: "VOICE_TRANSCRIPT",
        payload: { text: finalText.trim(), isFinal: true },
      }).catch(() => {});
    }
  };

  rec.onerror = (e: any) => {
    if (e.error === "not-allowed") {
      log("Mic permission denied");
      voiceActive = false;
      updateVoiceBtnState(false);
    }
  };

  rec.onend = () => {
    // Start a new fresh instance for the next sentence
    if (voiceActive) setTimeout(() => createAndStartRecognition(), 80);
  };

  try { rec.start(); } catch { if (voiceActive) setTimeout(() => createAndStartRecognition(), 300); }
}

function updateVoiceBtnState(active: boolean): void {
  const btn = document.getElementById("__wt_mic_btn__") as HTMLElement | null;
  if (!btn) return;
  btn.textContent = active ? "🔴" : "🎤";
  btn.style.background = active ? "rgba(255,71,87,0.3)" : "rgba(255,255,255,0.1)";
}

function startVoiceRecognition(): void {
  if (voiceActive) return;
  voiceActive = true;
  updateVoiceBtnState(true);
  createAndStartRecognition();
  log("Voice started (en-IN)");
}

function stopVoiceRecognition(): void {
  voiceActive = false;
  updateVoiceBtnState(false);
  log("Voice stopped");
}
