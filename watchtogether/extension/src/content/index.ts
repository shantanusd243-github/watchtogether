import type { InternalMessage, WatchEvent } from "../types/index";

// ─── State ────────────────────────────────────────────────────────────────────
let videoEl: HTMLVideoElement | null = null;
let isApplyingRemote = false;
let detectTimer: ReturnType<typeof setInterval> | null = null;
let lastReportedTime = -1;
let lastReportedPlaying: boolean | null = null;
const SEEK_DEBOUNCE_MS = 200;
let seekDebounce: ReturnType<typeof setTimeout> | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sendToBackground(msg: InternalMessage): void {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function log(...args: any[]): void {
  console.log("[WatchTogether Content]", ...args);
}

// ─── Video Detection ──────────────────────────────────────────────────────────
function findVideo(): HTMLVideoElement | null {
  // Search top document + all same-origin iframes
  const docs: Document[] = [document];
  try {
    for (const frame of Array.from(window.frames)) {
      try { docs.push(frame.document); } catch { /* cross-origin, skip */ }
    }
  } catch { /* frames not accessible */ }

  for (const doc of docs) {
    const videos = Array.from(doc.querySelectorAll<HTMLVideoElement>("video"));
    if (!videos.length) continue;

    // Operator precedence fix: wrap both conditions explicitly
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
    if (found && found !== videoEl) {
      attachListeners(found);
    }
  }, 1000);
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
function attachListeners(video: HTMLVideoElement): void {
  if (videoEl) detachListeners();
  videoEl = video;
  log("✅ Attached to video element — src:", video.src || video.currentSrc || "(blob/no src attr)");

  video.addEventListener("play", onPlay);
  video.addEventListener("pause", onPause);
  video.addEventListener("seeking", onSeeking);
  video.addEventListener("timeupdate", onTimeUpdate);
}

function detachListeners(): void {
  if (!videoEl) return;
  videoEl.removeEventListener("play", onPlay);
  videoEl.removeEventListener("pause", onPause);
  videoEl.removeEventListener("seeking", onSeeking);
  videoEl.removeEventListener("timeupdate", onTimeUpdate);
  videoEl = null;
}

// ─── Event Handlers ───────────────────────────────────────────────────────────
function onPlay(): void {
  if (isApplyingRemote) return;
  if (!videoEl) return;
  log("Local PLAY at", videoEl.currentTime);
  sendToBackground({
    type: "VIDEO_EVENT",
    payload: {
      type: "PLAY",
      currentTime: videoEl.currentTime,
      playing: true,
    } as Partial<WatchEvent>,
  });
  lastReportedPlaying = true;
}

function onPause(): void {
  if (isApplyingRemote) return;
  if (!videoEl) return;
  // Ignore transient pauses during seeking
  if (videoEl.seeking) return;
  log("Local PAUSE at", videoEl.currentTime);
  sendToBackground({
    type: "VIDEO_EVENT",
    payload: {
      type: "PAUSE",
      currentTime: videoEl.currentTime,
      playing: false,
    } as Partial<WatchEvent>,
  });
  lastReportedPlaying = false;
}

function onSeeking(): void {
  if (isApplyingRemote) return;
  if (!videoEl) return;
  if (seekDebounce) clearTimeout(seekDebounce);
  seekDebounce = setTimeout(() => {
    if (!videoEl) return;
    log("Local SEEK to", videoEl.currentTime);
    sendToBackground({
      type: "VIDEO_EVENT",
      payload: {
        type: "SEEK",
        currentTime: videoEl.currentTime,
        playing: !videoEl.paused,
      } as Partial<WatchEvent>,
    });
  }, SEEK_DEBOUNCE_MS);
}

function onTimeUpdate(): void {
  if (!videoEl) return;
  const now = videoEl.currentTime;
  const playing = !videoEl.paused;

  // Only report meaningful changes
  if (
    Math.abs(now - lastReportedTime) < 2 &&
    playing === lastReportedPlaying
  ) {
    return;
  }
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
          if (diff > 1) videoEl.currentTime = event.currentTime;
        }
        if (videoEl.paused) {
          await videoEl.play().catch((e) => log("play() failed:", e));
        }
        break;
      }
      case "PAUSE": {
        if (event.currentTime !== undefined) {
          const diff = Math.abs(videoEl.currentTime - event.currentTime);
          if (diff > 0.5) videoEl.currentTime = event.currentTime;
        }
        if (!videoEl.paused) {
          videoEl.pause();
        }
        break;
      }
      case "SEEK": {
        if (event.currentTime !== undefined) {
          videoEl.currentTime = event.currentTime;
        }
        break;
      }
      case "HEARTBEAT": {
        if (event.currentTime !== undefined) {
          const diff = Math.abs(videoEl.currentTime - event.currentTime);
          if (diff > 1.0) {
            log(`Heartbeat drift ${diff.toFixed(2)}s — correcting`);
            videoEl.currentTime = event.currentTime;
          }
          if (event.playing !== undefined) {
            if (event.playing && videoEl.paused) {
              await videoEl.play().catch(() => {});
            } else if (!event.playing && !videoEl.paused) {
              videoEl.pause();
            }
          }
        }
        break;
      }
    }
  } finally {
    // Small timeout so the video events fire before we stop ignoring them
    setTimeout(() => {
      isApplyingRemote = false;
    }, 300);
  }
}

// ─── Current State Reporter ───────────────────────────────────────────────────
function getCurrentState(): { currentTime: number; playing: boolean } {
  if (!videoEl) return { currentTime: 0, playing: false };
  return {
    currentTime: videoEl.currentTime,
    playing: !videoEl.paused,
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
        sendToBackground({
          type: "APPLY_REMOTE_EVENT",
          payload: s,
        });
        sendResponse(s);
        break;

      case "TRIGGER_JOIN":
        sendToBackground({
          type: "JOIN_ROOM",
          payload: { roomId: message.payload.roomId },
        });
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

// MutationObserver for SPAs that load video later
const observer = new MutationObserver(() => {
  const found = findVideo();
  if (found && found !== videoEl) {
    attachListeners(found);
  }
});
observer.observe(document.body, { childList: true, subtree: true });

log("Content script initialized on", window.location.href);
