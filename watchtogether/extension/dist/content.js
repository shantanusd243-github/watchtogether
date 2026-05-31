let videoEl = null;
let isApplyingRemote = false;
let detectTimer = null;
let lastReportedTime = -1;
let lastReportedPlaying = null;
const SEEK_DEBOUNCE_MS = 200;
let seekDebounce = null;
function sendToBackground(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
  });
}
function log(...args) {
  console.log("[WatchTogether Content]", ...args);
}
function findVideo() {
  const docs = [document];
  try {
    for (const frame of Array.from(window.frames)) {
      try {
        docs.push(frame.document);
      } catch {
      }
    }
  } catch {
  }
  for (const doc of docs) {
    const videos = Array.from(doc.querySelectorAll("video"));
    if (!videos.length) continue;
    const best = videos.find((v) => v.readyState >= 2 && !v.paused || v.currentTime > 0) || videos.find((v) => v.readyState >= 2) || videos.find((v) => v.readyState >= 1) || videos.find((v) => v.src !== "" || v.currentSrc !== "") || videos[0];
    if (best) return best;
  }
  return null;
}
function startDetection() {
  if (detectTimer) return;
  detectTimer = setInterval(() => {
    const found = findVideo();
    if (found && found !== videoEl) {
      attachListeners(found);
    }
  }, 1e3);
}
function attachListeners(video) {
  if (videoEl) detachListeners();
  videoEl = video;
  log("✅ Attached to video element — src:", video.src || video.currentSrc || "(blob/no src attr)");
  video.addEventListener("play", onPlay);
  video.addEventListener("pause", onPause);
  video.addEventListener("seeking", onSeeking);
  video.addEventListener("timeupdate", onTimeUpdate);
}
function detachListeners() {
  if (!videoEl) return;
  videoEl.removeEventListener("play", onPlay);
  videoEl.removeEventListener("pause", onPause);
  videoEl.removeEventListener("seeking", onSeeking);
  videoEl.removeEventListener("timeupdate", onTimeUpdate);
  videoEl = null;
}
function onPlay() {
  if (isApplyingRemote) return;
  if (!videoEl) return;
  log("Local PLAY at", videoEl.currentTime);
  sendToBackground({
    type: "VIDEO_EVENT",
    payload: {
      type: "PLAY",
      currentTime: videoEl.currentTime,
      playing: true
    }
  });
  lastReportedPlaying = true;
}
function onPause() {
  if (isApplyingRemote) return;
  if (!videoEl) return;
  if (videoEl.seeking) return;
  log("Local PAUSE at", videoEl.currentTime);
  sendToBackground({
    type: "VIDEO_EVENT",
    payload: {
      type: "PAUSE",
      currentTime: videoEl.currentTime,
      playing: false
    }
  });
  lastReportedPlaying = false;
}
function onSeeking() {
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
        playing: !videoEl.paused
      }
    });
  }, SEEK_DEBOUNCE_MS);
}
function onTimeUpdate() {
  if (!videoEl) return;
  const now = videoEl.currentTime;
  const playing = !videoEl.paused;
  if (Math.abs(now - lastReportedTime) < 2 && playing === lastReportedPlaying) {
    return;
  }
  lastReportedTime = now;
  lastReportedPlaying = playing;
}
async function applyRemoteEvent(event) {
  if (!videoEl) {
    log("No video element to apply event to");
    return;
  }
  isApplyingRemote = true;
  try {
    switch (event.type) {
      case "PLAY": {
        if (event.currentTime !== void 0) {
          const diff = Math.abs(videoEl.currentTime - event.currentTime);
          if (diff > 1) videoEl.currentTime = event.currentTime;
        }
        if (videoEl.paused) {
          await videoEl.play().catch((e) => log("play() failed:", e));
        }
        break;
      }
      case "PAUSE": {
        if (event.currentTime !== void 0) {
          const diff = Math.abs(videoEl.currentTime - event.currentTime);
          if (diff > 0.5) videoEl.currentTime = event.currentTime;
        }
        if (!videoEl.paused) {
          videoEl.pause();
        }
        break;
      }
      case "SEEK": {
        if (event.currentTime !== void 0) {
          videoEl.currentTime = event.currentTime;
        }
        break;
      }
      case "HEARTBEAT": {
        if (event.currentTime !== void 0) {
          const diff = Math.abs(videoEl.currentTime - event.currentTime);
          if (diff > 1) {
            log(`Heartbeat drift ${diff.toFixed(2)}s — correcting`);
            videoEl.currentTime = event.currentTime;
          }
          if (event.playing !== void 0) {
            if (event.playing && videoEl.paused) {
              await videoEl.play().catch(() => {
              });
            } else if (!event.playing && !videoEl.paused) {
              videoEl.pause();
            }
          }
        }
        break;
      }
    }
  } finally {
    setTimeout(() => {
      isApplyingRemote = false;
    }, 300);
  }
}
function getCurrentState() {
  if (!videoEl) return { currentTime: 0, playing: false };
  return {
    currentTime: videoEl.currentTime,
    playing: !videoEl.paused
  };
}
chrome.runtime.onMessage.addListener(
  (message, _sender, sendResponse) => {
    log("📨 Message received:", message.type, message.payload);
    switch (message.type) {
      case "APPLY_REMOTE_EVENT":
        applyRemoteEvent(message.payload);
        sendResponse({ ok: true });
        break;
      case "GET_STATE":
        const s = getCurrentState();
        log("📤 Reporting state:", s);
        sendToBackground({
          type: "APPLY_REMOTE_EVENT",
          payload: s
        });
        sendResponse(s);
        break;
      case "TRIGGER_JOIN":
        sendToBackground({
          type: "JOIN_ROOM",
          payload: { roomId: message.payload.roomId }
        });
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: "Unknown type" });
    }
    return true;
  }
);
const initialVideo = findVideo();
if (initialVideo) {
  attachListeners(initialVideo);
} else {
  startDetection();
}
const observer = new MutationObserver(() => {
  const found = findVideo();
  if (found && found !== videoEl) {
    attachListeners(found);
  }
});
observer.observe(document.body, { childList: true, subtree: true });
log("Content script initialized on", window.location.href);
//# sourceMappingURL=content.js.map
