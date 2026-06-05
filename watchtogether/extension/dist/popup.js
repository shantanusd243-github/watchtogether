import { i as initConfig, a as APP_BASE } from "./config.js";
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
  const movieNotOpened = !state.activeTabId;
  $("btn-open-movie").classList.toggle("hidden", !movieNotOpened);
  $("copy-hint").classList.toggle("hidden", !movieNotOpened);
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
async function openMovie() {
  const res = await send({ type: "OPEN_MOVIE" });
  if (res.error) {
    showError(res.error);
    return;
  }
  $("btn-open-movie").classList.add("hidden");
  $("copy-hint").classList.add("hidden");
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
    if (extState.userId) currentUserId = extState.userId;
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
let currentUserId = "";
function appendChatMessage(msg) {
  const msgs = $("chat-messages");
  if (!msgs) return;
  const isMine = msg.userId === currentUserId;
  const row = document.createElement("div");
  row.style.cssText = `display:flex;flex-direction:column;gap:2px;align-items:${isMine ? "flex-end" : "flex-start"};`;
  if (!isMine) {
    const name = document.createElement("div");
    name.className = "chat-msg-name";
    name.textContent = msg.displayName;
    row.appendChild(name);
  }
  const body = document.createElement("div");
  body.className = `chat-msg-body${isMine ? " chat-msg-mine" : ""}`;
  if (msg.isGif) {
    const img = document.createElement("img");
    img.src = msg.text;
    img.style.cssText = "max-width:180px;max-height:120px;border-radius:8px;display:block;";
    body.appendChild(img);
  } else {
    body.textContent = msg.text;
  }
  row.appendChild(body);
  msgs.appendChild(row);
  msgs.scrollTop = msgs.scrollHeight;
  const chatBtn = $("tab-chat-btn");
  if (chatBtn && !chatBtn.classList.contains("active") && !isMine) {
    chatBtn.textContent = "💬 Chat 🔴";
  }
}
async function sendChat() {
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  await send({ type: "SEND_CHAT", payload: { text, isGif: false } });
}
async function searchGif() {
  const q = $("gif-search-input").value.trim();
  if (!q) return;
  const results = $("gif-results");
  results.style.display = "flex";
  results.innerHTML = "<span style='color:var(--muted);font-size:11px;padding:4px;'>Searching…</span>";
  try {
    const r = await fetch(`https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}&key=AIzaSyAyimkuYQYF_FXVALexPmHA2zHg1GiRRH8&limit=8&media_filter=gif`);
    const data = await r.json();
    results.innerHTML = "";
    (data.results || []).forEach((res) => {
      const url = res.media_formats?.gif?.url || res.media_formats?.tinygif?.url;
      if (!url) return;
      const img = document.createElement("img");
      img.src = url;
      img.style.cssText = "width:72px;height:54px;object-fit:cover;border-radius:6px;cursor:pointer;";
      img.addEventListener("click", async () => {
        await send({ type: "SEND_CHAT", payload: { text: url, isGif: true } });
        results.style.display = "none";
        $("gif-search-input").value = "";
      });
      results.appendChild(img);
    });
    if (!results.children.length) results.innerHTML = "<span style='color:var(--muted);font-size:11px;'>No results</span>";
  } catch {
    results.innerHTML = "<span style='color:var(--danger);font-size:11px;'>Search failed</span>";
  }
}
function switchTab(tab) {
  const roomActions = $("room-actions");
  const viewChat = $("view-chat");
  const roomBtn = $("tab-room-btn");
  const chatBtn = $("tab-chat-btn");
  const roomCard = document.querySelector(".room-card");
  const copyHint = document.getElementById("copy-hint");
  const openMovieBtn = document.getElementById("btn-open-movie");
  if (tab === "room") {
    roomActions.classList.remove("hidden");
    viewChat.style.display = "none";
    roomBtn.classList.add("active");
    chatBtn.classList.remove("active");
    chatBtn.textContent = "💬 Chat";
    if (roomCard) roomCard.style.display = "";
    if (copyHint) copyHint.classList.remove("hidden");
    if (openMovieBtn) openMovieBtn.classList.remove("hidden");
    send({ type: "GET_STATE" }).then((res) => {
      if (res?.state?.roomState) updateRoomUI(res.state);
    });
  } else {
    roomActions.classList.add("hidden");
    viewChat.style.display = "flex";
    chatBtn.classList.add("active");
    chatBtn.textContent = "💬 Chat";
    roomBtn.classList.remove("active");
    if (roomCard) roomCard.style.display = "none";
    if (copyHint) copyHint.classList.add("hidden");
    if (openMovieBtn) openMovieBtn.classList.add("hidden");
    const msgs = $("chat-messages");
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  }
}
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "CHAT_RECEIVED") {
    appendChatMessage(message.payload);
  }
});
document.addEventListener("DOMContentLoaded", async () => {
  await initConfig();
  $("btn-create").addEventListener("click", createRoom);
  $("btn-join").addEventListener("click", joinRoom);
  $("btn-leave").addEventListener("click", leaveRoom);
  $("btn-leave-chat").addEventListener("click", leaveRoom);
  $("btn-open-movie").addEventListener("click", openMovie);
  $("btn-copy-link").addEventListener("click", copyShareUrl);
  $("copy-btn").addEventListener("click", copyShareUrl);
  $("pill-sync").addEventListener("click", toggleSyncMode);
  $("pill-control").addEventListener("click", toggleControlMode);
  $("tab-room-btn").addEventListener("click", () => switchTab("room"));
  $("tab-chat-btn").addEventListener("click", () => switchTab("chat"));
  $("chat-send-btn").addEventListener("click", sendChat);
  $("gif-search-btn").addEventListener("click", searchGif);
  $("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });
  $("gif-search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchGif();
  });
  $("join-room-id").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase();
  });
  const state = await send({ type: "GET_STATE" }).catch(() => null);
  if (state?.state?.userId) currentUserId = state.state.userId;
  refreshState();
});
//# sourceMappingURL=popup.js.map
