const APP_BASE = "http://localhost:5173";
function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(response);
    });
  });
}
function $(id) {
  return document.getElementById(id);
}
function showLoading(text = "Loading…") {
  $("view-loading").classList.remove("hidden");
  $("view-home").classList.add("hidden");
  $("view-room").classList.add("hidden");
  $("loading-text").textContent = text;
}
function showHome() {
  $("view-loading").classList.add("hidden");
  $("view-home").classList.remove("hidden");
  $("view-room").classList.add("hidden");
  clearError();
}
function showRoom(state) {
  $("view-loading").classList.add("hidden");
  $("view-home").classList.add("hidden");
  $("view-room").classList.remove("hidden");
  if (state.roomState) {
    updateRoomUI(state);
  }
}
function showError(msg) {
  const el = $("error-msg");
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 5e3);
}
function clearError() {
  $("error-msg").classList.add("hidden");
}
function updateRoomUI(state) {
  const room = state.roomState;
  $("room-id-display").textContent = room.roomId;
  $("user-count").textContent = String(
    room.participants?.length ?? 1
  );
  const shareUrl = `${APP_BASE}/room/${room.roomId}`;
  $("share-url-display").textContent = shareUrl;
  $("movie-url-display").textContent = room.movieUrl ?? "—";
  const isSynced = room.syncMode === "SYNC";
  const pillSync = $("pill-sync");
  pillSync.classList.toggle("active", isSynced);
  pillSync.classList.toggle("sync", isSynced);
  $("sync-mode-label").textContent = room.syncMode;
  const isOwnerMode = room.controlMode === "OWNER";
  const pillControl = $("pill-control");
  const isOwner = state.userId === room.ownerId;
  pillControl.classList.toggle("active", isOwnerMode);
  pillControl.style.opacity = isOwner ? "1" : "0.5";
  pillControl.style.cursor = isOwner ? "pointer" : "not-allowed";
  $("control-mode-label").textContent = room.controlMode;
  const badge = $("ws-badge");
  badge.classList.toggle("connected", state.wsConnected);
  badge.classList.toggle("disconnected", !state.wsConnected);
}
async function createRoom() {
  const url = $("movie-url").value.trim();
  if (!url) {
    showError("Please enter a movie URL.");
    return;
  }
  try {
    new URL(url);
  } catch {
    showError("Please enter a valid URL.");
    return;
  }
  showLoading("Creating room…");
  try {
    const res = await send({ type: "CREATE_ROOM", payload: { movieUrl: url } });
    if (res.error) throw new Error(res.error);
  } catch (e) {
    showHome();
    showError(e.message ?? "Failed to create room.");
  }
}
async function joinRoom() {
  const roomId = $("join-room-id").value.trim().toUpperCase();
  if (!roomId) {
    showError("Please enter a Room ID.");
    return;
  }
  showLoading("Joining room…");
  try {
    const res = await send({ type: "JOIN_ROOM", payload: { roomId } });
    if (res.error) throw new Error(res.error);
  } catch (e) {
    showHome();
    showError(e.message ?? "Failed to join room.");
  }
}
async function leaveRoom() {
  showLoading("Leaving…");
  armLoadingWatchdog();
  await send({ type: "LEAVE_ROOM" });
}
async function toggleSyncMode() {
  try {
    await send({ type: "TOGGLE_SYNC_MODE" });
  } catch (e) {
    showError(e.message ?? "Failed to toggle sync mode.");
  }
}
async function toggleControlMode() {
  try {
    const res = await send({ type: "TOGGLE_CONTROL_MODE" });
    if (res.error) showError(res.error);
  } catch (e) {
    showError(e.message ?? "Failed to toggle control mode.");
  }
}
function copyShareUrl() {
  const el = $("share-url-display");
  const url = el.textContent ?? "";
  if (!url || url === "—") return;
  navigator.clipboard.writeText(url).then(() => {
    const btn = $("copy-btn");
    btn.textContent = "✓ Copied";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = "Copy";
      btn.classList.remove("copied");
    }, 2e3);
  });
}
chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case "STATE_UPDATE":
      const extState = message.payload;
      if (extState.roomState) {
        showRoom(extState);
      } else {
        showHome();
      }
      break;
    case "WS_CONNECTED":
    case "WS_DISCONNECTED":
      refreshState();
      break;
  }
});
async function refreshState() {
  try {
    const res = await send({ type: "GET_STATE" });
    const extState = res.state;
    if (extState.roomState) {
      showRoom(extState);
    } else {
      showHome();
    }
    const badge = $("ws-badge");
    badge.classList.toggle("connected", extState.wsConnected);
    badge.classList.toggle("disconnected", !extState.wsConnected);
  } catch {
    showHome();
  }
}
let loadingWatchdog = null;
function armLoadingWatchdog() {
  if (loadingWatchdog) clearTimeout(loadingWatchdog);
  loadingWatchdog = setTimeout(() => {
    const loadingEl = $("view-loading");
    if (!loadingEl.classList.contains("hidden")) {
      console.warn("[WatchTogether Popup] Stuck on loading — recovering via GET_STATE");
      refreshState();
    }
  }, 4e3);
}
document.addEventListener("DOMContentLoaded", () => {
  $("btn-create").addEventListener("click", createRoom);
  $("btn-join").addEventListener("click", joinRoom);
  $("btn-leave").addEventListener("click", leaveRoom);
  $("btn-copy-link").addEventListener("click", copyShareUrl);
  $("copy-btn").addEventListener("click", copyShareUrl);
  $("pill-sync").addEventListener("click", toggleSyncMode);
  $("pill-control").addEventListener("click", toggleControlMode);
  $("join-room-id").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase();
  });
  refreshState();
});
//# sourceMappingURL=popup.js.map
