const API_BASE = "https://watch-together-prod.up.railway.app/api";
const WS_BASE = "wss://watch-together-prod.up.railway.app/ws";
const APP_BASE = "https://watchtogether-zeta.vercel.app";
let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let state = {
  connected: false,
  roomState: null,
  userId: generateUserId(),
  activeTabId: void 0,
  activeFrameId: 0,
  wsConnected: false
};
function generateUserId() {
  return "user_" + Math.random().toString(36).substring(2, 10);
}
async function loadState() {
  const stored = await chrome.storage.local.get([
    "userId",
    "roomState",
    "activeTabId"
  ]);
  if (stored.userId) state.userId = stored.userId;
  if (stored.roomState) state.roomState = stored.roomState;
  if (stored.activeTabId) state.activeTabId = stored.activeTabId;
}
async function saveState() {
  await chrome.storage.local.set({
    userId: state.userId,
    roomState: state.roomState,
    activeTabId: state.activeTabId
  });
}
function broadcastToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
  });
}
function broadcastToContentScript(msg) {
  if (state.activeTabId) {
    chrome.tabs.sendMessage(state.activeTabId, msg, { frameId: state.activeFrameId ?? 0 }).catch(() => {
    });
  }
}
function connectWebSocket(roomId) {
  if (socket && socket.readyState === WebSocket.OPEN) return;
  const url = `${WS_BASE}/room/${roomId}?userId=${state.userId}`;
  socket = new WebSocket(url);
  socket.onopen = () => {
    console.log("[WatchTogether] WebSocket connected");
    state.wsConnected = true;
    reconnectAttempts = 0;
    broadcastToPopup({ type: "WS_CONNECTED" });
    startHeartbeat();
  };
  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleRemoteEvent(msg);
    } catch (e) {
      console.error("[WatchTogether] Failed to parse WS message:", e);
    }
  };
  socket.onclose = () => {
    console.log("[WatchTogether] WebSocket disconnected");
    state.wsConnected = false;
    stopHeartbeat();
    broadcastToPopup({ type: "WS_DISCONNECTED" });
    scheduleReconnect(roomId);
  };
  socket.onerror = (err) => {
    console.error("[WatchTogether] WebSocket error:", err);
  };
}
function disconnectWebSocket() {
  stopHeartbeat();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.close();
    socket = null;
  }
  state.wsConnected = false;
}
function scheduleReconnect(roomId) {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.warn("[WatchTogether] Max reconnect attempts reached — verifying room still exists");
    verifyRoomOrReset(roomId);
    return;
  }
  const delay = Math.min(1e3 * Math.pow(2, reconnectAttempts), 3e4);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => connectWebSocket(roomId), delay);
}
async function verifyRoomOrReset(roomId) {
  try {
    const res = await fetch(`${API_BASE}/rooms/${roomId}`);
    if (res.ok) {
      reconnectTimer = setTimeout(() => {
        reconnectAttempts = 0;
        connectWebSocket(roomId);
      }, 5e3);
    } else {
      console.warn("[WatchTogether] Room no longer exists on server — clearing state");
      await resetLocalState();
    }
  } catch {
    console.warn("[WatchTogether] Server unreachable, keeping state for manual retry");
    broadcastToPopup({ type: "WS_DISCONNECTED" });
  }
}
function sendWsEvent(event) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!state.roomState) return;
    if (state.roomState.syncMode === "SYNC") {
      broadcastToContentScript({ type: "GET_STATE" });
    }
  }, 5e3);
}
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
function handleRemoteEvent(event) {
  if (event.userId === state.userId) return;
  if (!state.roomState) return;
  switch (event.type) {
    case "MODE_CHANGE":
      if (event.syncMode) state.roomState.syncMode = event.syncMode;
      if (event.controlMode) state.roomState.controlMode = event.controlMode;
      saveState();
      broadcastToPopup({ type: "STATE_UPDATE", payload: state });
      break;
    case "JOIN":
    case "LEAVE":
      refreshRoomState(state.roomState.roomId);
      break;
    case "HEARTBEAT":
    case "PLAY":
    case "PAUSE":
    case "SEEK":
      if (state.roomState.syncMode === "SYNC") {
        broadcastToContentScript({ type: "APPLY_REMOTE_EVENT", payload: event });
      }
      break;
  }
}
async function refreshRoomState(roomId) {
  try {
    const res = await fetch(`${API_BASE}/rooms/${roomId}`);
    if (res.ok) {
      const roomState = await res.json();
      state.roomState = roomState;
      await saveState();
      broadcastToPopup({ type: "STATE_UPDATE", payload: state });
    } else if (res.status === 404) {
      console.warn("[WatchTogether] Room gone (404) — resetting state");
      await resetLocalState();
    }
  } catch (e) {
    console.error("[WatchTogether] Failed to refresh room state:", e);
  }
}
async function createRoom(movieUrl) {
  try {
    const res = await fetch(`${API_BASE}/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ movieUrl, userId: state.userId })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data;
  } catch (e) {
    console.error("[WatchTogether] createRoom failed:", e);
    return null;
  }
}
async function joinRoom(roomId) {
  try {
    const res = await fetch(`${API_BASE}/rooms/${roomId}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: state.userId })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data;
  } catch (e) {
    console.error("[WatchTogether] joinRoom failed:", e);
    return null;
  }
}
async function resetLocalState() {
  disconnectWebSocket();
  state.roomState = null;
  state.activeTabId = void 0;
  reconnectAttempts = 0;
  await chrome.storage.local.remove(["roomState", "activeTabId"]);
  broadcastToPopup({ type: "STATE_UPDATE", payload: state });
}
async function leaveRoom() {
  if (!state.roomState) return;
  const roomId = state.roomState.roomId;
  await resetLocalState();
  fetch(`${API_BASE}/rooms/${roomId}/leave`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: state.userId })
  }).catch((e) => console.warn("[WatchTogether] leaveRoom server call failed:", e));
}
chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    if (sender.tab?.id && state.roomState) {
      const isIframe = (sender.frameId ?? 0) > 0;
      if (isIframe || state.activeTabId === void 0) {
        state.activeTabId = sender.tab.id;
        state.activeFrameId = sender.frameId ?? 0;
      }
    }
    handleMessage(message, sendResponse);
    return true;
  }
);
async function handleMessage(message, sendResponse) {
  switch (message.type) {
    case "CREATE_ROOM": {
      const { movieUrl } = message.payload;
      const result = await createRoom(movieUrl);
      if (!result) {
        sendResponse({ error: "Failed to create room" });
        return;
      }
      const roomRes = await fetch(`${API_BASE}/rooms/${result.roomId}`);
      state.roomState = await roomRes.json();
      await saveState();
      connectWebSocket(result.roomId);
      sendResponse({
        ...result,
        shareUrl: `${APP_BASE}/room/${result.roomId}`
      });
      broadcastToPopup({ type: "STATE_UPDATE", payload: state });
      break;
    }
    case "OPEN_MOVIE": {
      if (!state.roomState) {
        sendResponse({ error: "No active room" });
        return;
      }
      const tab = await chrome.tabs.create({ url: state.roomState.movieUrl });
      state.activeTabId = tab.id;
      await saveState();
      sendResponse({ success: true });
      break;
    }
    case "JOIN_ROOM": {
      const { roomId } = message.payload;
      const result = await joinRoom(roomId);
      if (!result) {
        sendResponse({ error: "Failed to join room" });
        return;
      }
      const tab = await chrome.tabs.create({ url: result.roomState.movieUrl });
      state.activeTabId = tab.id;
      state.roomState = result.roomState;
      await saveState();
      connectWebSocket(roomId);
      sendResponse({ success: true, roomState: result.roomState });
      broadcastToPopup({ type: "STATE_UPDATE", payload: state });
      break;
    }
    case "LEAVE_ROOM": {
      await leaveRoom();
      sendResponse({ success: true });
      break;
    }
    case "GET_STATE": {
      sendResponse({ state });
      break;
    }
    case "TOGGLE_SYNC_MODE": {
      if (!state.roomState) {
        sendResponse({ error: "No active room" });
        return;
      }
      const newMode = state.roomState.syncMode === "SYNC" ? "INDEPENDENT" : "SYNC";
      state.roomState.syncMode = newMode;
      await saveState();
      sendWsEvent({
        roomId: state.roomState.roomId,
        userId: state.userId,
        type: "MODE_CHANGE",
        syncMode: newMode
      });
      sendResponse({ syncMode: newMode });
      broadcastToPopup({ type: "STATE_UPDATE", payload: state });
      break;
    }
    case "TOGGLE_CONTROL_MODE": {
      if (!state.roomState) {
        sendResponse({ error: "No active room" });
        return;
      }
      if (state.userId !== state.roomState.ownerId) {
        sendResponse({ error: "Only room owner can change control mode" });
        return;
      }
      const newControl = state.roomState.controlMode === "OWNER" ? "SHARED" : "OWNER";
      state.roomState.controlMode = newControl;
      await saveState();
      sendWsEvent({
        roomId: state.roomState.roomId,
        userId: state.userId,
        type: "MODE_CHANGE",
        controlMode: newControl
      });
      sendResponse({ controlMode: newControl });
      broadcastToPopup({ type: "STATE_UPDATE", payload: state });
      break;
    }
    case "VIDEO_EVENT": {
      const event = message.payload;
      if (!state.roomState) return;
      const { syncMode, controlMode, ownerId } = state.roomState;
      if (syncMode === "INDEPENDENT") return;
      if (controlMode === "OWNER" && state.userId !== ownerId) return;
      sendWsEvent({ ...event, userId: state.userId, roomId: state.roomState.roomId });
      break;
    }
    case "APPLY_REMOTE_EVENT": {
      const { currentTime, playing } = message.payload;
      if (!state.roomState) return;
      sendWsEvent({
        roomId: state.roomState.roomId,
        userId: state.userId,
        type: "HEARTBEAT",
        currentTime,
        playing
      });
      break;
    }
    default:
      sendResponse({ error: `Unknown message type: ${message.type}` });
  }
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    const match = tab.url.match(/\/room\/([A-Z0-9]+)$/);
    if (match) {
      const roomId = match[1];
      if (!state.roomState || state.roomState.roomId !== roomId) {
        chrome.tabs.sendMessage(tabId, {
          type: "TRIGGER_JOIN",
          payload: { roomId }
        }).catch(() => {
        });
      }
    }
  }
});
loadState().then(async () => {
  if (!state.roomState) return;
  try {
    const res = await fetch(`${API_BASE}/rooms/${state.roomState.roomId}`);
    if (res.ok) {
      connectWebSocket(state.roomState.roomId);
    } else {
      console.warn("[WatchTogether] Stored room no longer valid — clearing on startup");
      await resetLocalState();
    }
  } catch {
    console.warn("[WatchTogether] Server unreachable at startup, state preserved");
  }
});
//# sourceMappingURL=background.js.map
