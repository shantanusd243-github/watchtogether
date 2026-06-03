let videoEl = null;
let isApplyingRemote = false;
let detectTimer = null;
let lastReportedTime = -1;
let lastReportedPlaying = null;
let lastReportedRate = 1;
const SEEK_DEBOUNCE_MS = 200;
let seekDebounce = null;
const POST_SEEK_SETTLE_MS = 5e3;
let lastLocalSeekAt = 0;
function sendToBackground(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
  });
}
function log(...args) {
  console.log("[WatchTogether Content]", ...args);
}
const _currentTimeDesc = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "currentTime") ?? Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
const _playbackRateDesc = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "playbackRate") ?? Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "playbackRate");
function nativeSetCurrentTime(video, t) {
  if (_currentTimeDesc?.set) {
    _currentTimeDesc.set.call(video, t);
  } else {
    video.currentTime = t;
  }
}
function nativeSetPlaybackRate(video, r) {
  if (_playbackRateDesc?.set) {
    _playbackRateDesc.set.call(video, r);
  } else {
    video.playbackRate = r;
  }
}
async function nativePlay(video) {
  if (!video.paused) return;
  try {
    await video.play();
    await new Promise((r) => setTimeout(r, 200));
    if (video.paused) throw new Error("still paused");
  } catch {
    log("play() blocked — using Space key fallback");
    video.ownerDocument.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", code: "Space", keyCode: 32, bubbles: true })
    );
  }
}
function nativePause(video) {
  if (video.paused) return;
  video.pause();
  setTimeout(() => {
    if (!video.paused) {
      log("pause() blocked — using Space key fallback");
      video.ownerDocument.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", code: "Space", keyCode: 32, bubbles: true })
      );
    }
  }, 100);
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
    if (found && found !== videoEl) attachListeners(found);
  }, 1e3);
}
function attachListeners(video) {
  if (videoEl) detachListeners();
  videoEl = video;
  log("✅ Attached to video — src:", video.src || video.currentSrc || "(blob)");
  video.addEventListener("play", onPlay);
  video.addEventListener("pause", onPause);
  video.addEventListener("seeking", onSeeking);
  video.addEventListener("ratechange", onRateChange);
  video.addEventListener("timeupdate", onTimeUpdate);
}
function detachListeners() {
  if (!videoEl) return;
  videoEl.removeEventListener("play", onPlay);
  videoEl.removeEventListener("pause", onPause);
  videoEl.removeEventListener("seeking", onSeeking);
  videoEl.removeEventListener("ratechange", onRateChange);
  videoEl.removeEventListener("timeupdate", onTimeUpdate);
  videoEl = null;
}
function onPlay() {
  if (isApplyingRemote) return;
  if (!videoEl) return;
  log("Local PLAY at", videoEl.currentTime);
  sendToBackground({
    type: "VIDEO_EVENT",
    payload: { type: "PLAY", currentTime: videoEl.currentTime, playing: true }
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
    payload: { type: "PAUSE", currentTime: videoEl.currentTime, playing: false }
  });
  lastReportedPlaying = false;
}
function onSeeking() {
  if (isApplyingRemote) return;
  if (!videoEl) return;
  lastLocalSeekAt = Date.now();
  if (seekDebounce) clearTimeout(seekDebounce);
  seekDebounce = setTimeout(() => {
    if (!videoEl) return;
    log("Local SEEK to", videoEl.currentTime);
    sendToBackground({
      type: "VIDEO_EVENT",
      payload: { type: "SEEK", currentTime: videoEl.currentTime, playing: !videoEl.paused }
    });
  }, SEEK_DEBOUNCE_MS);
}
function onRateChange() {
  if (isApplyingRemote) return;
  if (!videoEl) return;
  const rate = videoEl.playbackRate;
  if (rate === lastReportedRate) return;
  lastReportedRate = rate;
  log("Local SPEED change to", rate);
  sendToBackground({
    type: "VIDEO_EVENT",
    payload: { type: "SPEED", currentTime: videoEl.currentTime, playbackRate: rate }
  });
}
function onTimeUpdate() {
  if (!videoEl) return;
  const now = videoEl.currentTime;
  const playing = !videoEl.paused;
  if (Math.abs(now - lastReportedTime) < 2 && playing === lastReportedPlaying) return;
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
          if (diff > 1) nativeSetCurrentTime(videoEl, event.currentTime);
        }
        await nativePlay(videoEl);
        break;
      }
      case "PAUSE": {
        if (event.currentTime !== void 0) {
          const diff = Math.abs(videoEl.currentTime - event.currentTime);
          if (diff > 0.5) nativeSetCurrentTime(videoEl, event.currentTime);
        }
        nativePause(videoEl);
        break;
      }
      case "SEEK": {
        if (event.currentTime !== void 0) {
          nativeSetCurrentTime(videoEl, event.currentTime);
        }
        break;
      }
      case "SPEED": {
        if (event.playbackRate !== void 0) {
          log("Remote SPEED change to", event.playbackRate);
          nativeSetPlaybackRate(videoEl, event.playbackRate);
        }
        break;
      }
      case "HEARTBEAT": {
        if (event.currentTime === void 0) break;
        const msSinceLocalSeek = Date.now() - lastLocalSeekAt;
        if (msSinceLocalSeek < POST_SEEK_SETTLE_MS) {
          log(`Heartbeat suppressed — ${msSinceLocalSeek}ms since local seek, still settling`);
          break;
        }
        const diff = Math.abs(videoEl.currentTime - event.currentTime);
        if (diff > 1) {
          log(`Heartbeat drift ${diff.toFixed(2)}s — correcting`);
          nativeSetCurrentTime(videoEl, event.currentTime);
        }
        if (event.playbackRate !== void 0 && videoEl.playbackRate !== event.playbackRate) {
          nativeSetPlaybackRate(videoEl, event.playbackRate);
        }
        if (event.playing !== void 0) {
          if (event.playing && videoEl.paused) await nativePlay(videoEl);
          else if (!event.playing && !videoEl.paused) nativePause(videoEl);
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
  if (!videoEl) return { currentTime: 0, playing: false, playbackRate: 1 };
  return {
    currentTime: videoEl.currentTime,
    playing: !videoEl.paused,
    playbackRate: videoEl.playbackRate
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
//# sourceMappingURL=content.js.map
