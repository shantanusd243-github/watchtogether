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

// After a local seek/speed change, suppress heartbeat corrections briefly
// to prevent ping-pong override loops between users.
const POST_SEEK_SETTLE_MS = 5000;
let lastLocalSeekAt = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sendToBackground(msg: InternalMessage): void {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function log(...args: any[]): void {
  console.log("[WatchTogether Content]", ...args);
}

// ─── Native method cache ──────────────────────────────────────────────────────
// Grab real setters BEFORE any player framework (Netflix, JWPlayer) overrides them.
const _currentTimeDesc =
  Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "currentTime") ??
  Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");

const _playbackRateDesc =
  Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "playbackRate") ??
  Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "playbackRate");

function nativeSetCurrentTime(video: HTMLVideoElement, t: number): void {
  if (_currentTimeDesc?.set) {
    _currentTimeDesc.set.call(video, t);
  } else {
    video.currentTime = t;
  }
}

function nativeSetPlaybackRate(video: HTMLVideoElement, r: number): void {
  if (_playbackRateDesc?.set) {
    _playbackRateDesc.set.call(video, r);
  } else {
    video.playbackRate = r;
  }
}

// Netflix and some players block programmatic play()/pause() from extensions.
// Dispatching a Space keydown on document.body triggers the player's own handler.
// We try native first; if it throws or the state doesn't change, fall back to key.
async function nativePlay(video: HTMLVideoElement): Promise<void> {
  if (!video.paused) return;
  try {
    await video.play();
    // Give it 200ms; if still paused, use keyboard fallback
    await new Promise((r) => setTimeout(r, 200));
    if (video.paused) throw new Error("still paused");
  } catch {
    log("play() blocked — using Space key fallback");
    video.ownerDocument.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", code: "Space", keyCode: 32, bubbles: true })
    );
  }
}

function nativePause(video: HTMLVideoElement): void {
  if (video.paused) return;
  video.pause();
  // Give it 100ms; if still playing, use keyboard fallback
  setTimeout(() => {
    if (!video.paused) {
      log("pause() blocked — using Space key fallback");
      video.ownerDocument.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", code: "Space", keyCode: 32, bubbles: true })
      );
    }
  }, 100);
}

// ─── Video Detection ──────────────────────────────────────────────────────────
function findVideo(): HTMLVideoElement | null {
  const docs: Document[] = [document];
  try {
    for (const frame of Array.from(window.frames)) {
      try { docs.push(frame.document); } catch { /* cross-origin iframe — skip */ }
    }
  } catch { /* no frames */ }

  for (const doc of docs) {
    const videos = Array.from(doc.querySelectorAll<HTMLVideoElement>("video"));
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
  if (isApplyingRemote) return;
  if (!videoEl) return;
  log("Local PLAY at", videoEl.currentTime);
  sendToBackground({
    type: "VIDEO_EVENT",
    payload: { type: "PLAY", currentTime: videoEl.currentTime, playing: true } as Partial<WatchEvent>,
  });
  lastReportedPlaying = true;
}

function onPause(): void {
  if (isApplyingRemote) return;
  if (!videoEl) return;
  if (videoEl.seeking) return; // transient pause during seek — ignore
  log("Local PAUSE at", videoEl.currentTime);
  sendToBackground({
    type: "VIDEO_EVENT",
    payload: { type: "PAUSE", currentTime: videoEl.currentTime, playing: false } as Partial<WatchEvent>,
  });
  lastReportedPlaying = false;
}

function onSeeking(): void {
  if (isApplyingRemote) return;
  if (!videoEl) return;
  lastLocalSeekAt = Date.now(); // arm the settle window
  if (seekDebounce) clearTimeout(seekDebounce);
  seekDebounce = setTimeout(() => {
    if (!videoEl) return;
    log("Local SEEK to", videoEl.currentTime);
    sendToBackground({
      type: "VIDEO_EVENT",
      payload: { type: "SEEK", currentTime: videoEl.currentTime, playing: !videoEl.paused } as Partial<WatchEvent>,
    });
  }, SEEK_DEBOUNCE_MS);
}

function onRateChange(): void {
  if (isApplyingRemote) return;
  if (!videoEl) return;
  const rate = videoEl.playbackRate;
  if (rate === lastReportedRate) return;
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

        // Suppress corrections during the settle window after a local seek.
        // This is what breaks the ping-pong override loop.
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

        if (event.playbackRate !== undefined && videoEl.playbackRate !== event.playbackRate) {
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
    setTimeout(() => { isApplyingRemote = false; }, 300);
  }
}

// ─── Current State Reporter ───────────────────────────────────────────────────
function getCurrentState(): { currentTime: number; playing: boolean; playbackRate: number } {
  if (!videoEl) return { currentTime: 0, playing: false, playbackRate: 1 };
  return {
    currentTime: videoEl.currentTime,
    playing: !videoEl.paused,
    playbackRate: videoEl.playbackRate,
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

      case "GET_STATE":
        const s = getCurrentState();
        log("📤 Reporting state:", s);
        sendToBackground({ type: "APPLY_REMOTE_EVENT", payload: s });
        sendResponse(s);
        break;

      case "TRIGGER_JOIN":
        sendToBackground({ type: "JOIN_ROOM", payload: { roomId: message.payload.roomId } });
        sendResponse({ ok: true });
        break;

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
observer.observe(document.body, { childList: true, subtree: true });

log("Content script initialized on", window.location.href);
