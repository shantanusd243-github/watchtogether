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
        if (event.currentTime !== undefined) {
          const diff = Math.abs(videoEl.currentTime - event.currentTime);
          if (diff > 1) nativeSetCurrentTime(videoEl, event.currentTime);
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
        if (event.currentTime !== undefined) {
          nativeSetCurrentTime(videoEl, event.currentTime);
        }
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

        const diff = Math.abs(videoEl.currentTime - event.currentTime);
        if (diff > 1.0) {
          log(`Heartbeat drift ${diff.toFixed(2)}s — correcting`);
          nativeSetCurrentTime(videoEl, event.currentTime);
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

      default:
        sendResponse({ ok: false, error: "Unknown type" });
    }
    return true;
  }
);

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
