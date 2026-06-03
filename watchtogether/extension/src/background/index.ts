import type {
  ExtensionState,
  InternalMessage,
  WatchEvent,
  RoomState,
  CreateRoomResponse,
  JoinRoomResponse,
} from "../types/index";

// ─── Config ───────────────────────────────────────────────────────────────────
// All URLs are loaded from config.json at runtime — no hardcoded values here.
import { API_BASE, WS_BASE, APP_BASE, initConfig } from "../config";

// ─── State ────────────────────────────────────────────────────────────────────
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

let state: ExtensionState = {
  connected: false,
  roomState: null,
  userId: generateUserId(),
  activeTabId: undefined,
  activeFrameId: 0,
  wsConnected: false,
};

// ─── Utility ─────────────────────────────────────────────────────────────────
function generateUserId(): string {
  return "user_" + Math.random().toString(36).substring(2, 10);
}

async function loadState(): Promise<void> {
  const stored = await chrome.storage.local.get([
    "userId",
    "roomState",
    "activeTabId",
    "activeFrameId",
  ]);
  if (stored.userId) state.userId = stored.userId;
  if (stored.roomState) state.roomState = stored.roomState;
  if (stored.activeTabId !== undefined) state.activeTabId = stored.activeTabId;
  if (stored.activeFrameId !== undefined) state.activeFrameId = stored.activeFrameId;
}

async function saveState(): Promise<void> {
  await chrome.storage.local.set({
    userId: state.userId,
    roomState: state.roomState,
    activeTabId: state.activeTabId,
    activeFrameId: state.activeFrameId ?? 0,
  });
}

function broadcastToPopup(msg: InternalMessage): void {
  chrome.runtime.sendMessage(msg).catch(() => {
    /* popup may be closed */
  });
}

function broadcastToContentScript(msg: InternalMessage): void {
  if (state.activeTabId === undefined) return;
  chrome.tabs.sendMessage(
    state.activeTabId,
    msg,
    { frameId: state.activeFrameId ?? 0 }
  ).catch(() => {
    /* tab/frame may not have content script */
  });
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
function connectWebSocket(roomId: string): void {
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
      const msg: WatchEvent = JSON.parse(event.data);
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

function disconnectWebSocket(): void {
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

function scheduleReconnect(roomId: string): void {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.warn("[WatchTogether] Max reconnect attempts reached — verifying room still exists");
    verifyRoomOrReset(roomId);
    return;
  }
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => connectWebSocket(roomId), delay);
}

/**
 * Called when reconnection is exhausted or on popup open with stored state.
 * Hits the REST endpoint: if the room is gone (404) or unreachable, clears
 * all local state so the popup reverts to the home screen.
 */
async function verifyRoomOrReset(roomId: string): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/rooms/${roomId}`);
    if (res.ok) {
      reconnectTimer = setTimeout(() => {
        reconnectAttempts = 0;
        connectWebSocket(roomId);
      }, 5000);
    } else {
      console.warn("[WatchTogether] Room no longer exists on server — clearing state");
      await resetLocalState();
    }
  } catch {
    console.warn("[WatchTogether] Server unreachable, keeping state for manual retry");
    broadcastToPopup({ type: "WS_DISCONNECTED" });
  }
}

function sendWsEvent(event: WatchEvent): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────
function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!state.roomState) return;
    if (state.roomState.syncMode === "SYNC") {
      broadcastToContentScript({ type: "GET_STATE" });
    }
  }, 5000);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ─── Remote Event Handling ────────────────────────────────────────────────────
function handleRemoteEvent(event: WatchEvent): void {
  if (event.userId === state.userId) return; // Ignore own events
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
    case "SPEED":
      if (state.roomState.syncMode === "SYNC") {
        broadcastToContentScript({ type: "APPLY_REMOTE_EVENT", payload: event });
      }
      break;

    default:
      break;
  }
}

async function refreshRoomState(roomId: string): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/rooms/${roomId}`);
    if (res.ok) {
      const roomState: RoomState = await res.json();
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

// ─── Room Operations ──────────────────────────────────────────────────────────
async function createRoom(movieUrl: string): Promise<CreateRoomResponse | null> {
  try {
    const res = await fetch(`${API_BASE}/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ movieUrl, userId: state.userId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: CreateRoomResponse = await res.json();
    return data;
  } catch (e) {
    console.error("[WatchTogether] createRoom failed:", e);
    return null;
  }
}

async function joinRoom(roomId: string): Promise<JoinRoomResponse | null> {
  try {
    const res = await fetch(`${API_BASE}/rooms/${roomId}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: state.userId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: JoinRoomResponse = await res.json();
    return data;
  } catch (e) {
    console.error("[WatchTogether] joinRoom failed:", e);
    return null;
  }
}

/**
 * Single source of truth for clearing all room state — in memory, storage,
 * and WebSocket — then notifies the popup to return to the home screen.
 */
async function resetLocalState(): Promise<void> {
  disconnectWebSocket();
  state.roomState = null;
  state.activeTabId = undefined;
  state.activeFrameId = 0;
  reconnectAttempts = 0;
  await chrome.storage.local.remove(["roomState", "activeTabId", "activeFrameId"]);
  broadcastToPopup({ type: "STATE_UPDATE", payload: state });
}

async function leaveRoom(): Promise<void> {
  if (!state.roomState) return;
  const roomId = state.roomState.roomId;
  await resetLocalState();
  fetch(`${API_BASE}/rooms/${roomId}/leave`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: state.userId }),
  }).catch((e) => console.warn("[WatchTogether] leaveRoom server call failed:", e));
}

// ─── Message Handling ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(
  (message: InternalMessage, sender, sendResponse) => {
    // Update activeTabId + activeFrameId from the sender on every message.
    // Prefer iframe frames (frameId > 0) over the top frame because the video
    // is often inside a cross-origin iframe.
    if (sender.tab?.id && state.roomState) {
      const isIframe = (sender.frameId ?? 0) > 0;
      if (isIframe || state.activeTabId === undefined) {
        state.activeTabId = sender.tab.id;
        state.activeFrameId = sender.frameId ?? 0;
      }
    }
    handleMessage(message, sendResponse);
    return true;
  }
);

async function handleMessage(
  message: InternalMessage,
  sendResponse: (r: any) => void
): Promise<void> {
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
        shareUrl: `${APP_BASE}/room/${result.roomId}`,
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
      state.activeFrameId = 0;
      await saveState();
      sendResponse({ success: true });
      break;
    }

    case "JOIN_ROOM": {
      const { roomId, sourceTabId } = message.payload || {};
      const result = await joinRoom(roomId);
      if (!result) {
        sendResponse({ error: "Failed to join room" });
        return;
      }

      state.roomState = result.roomState;
      state.activeFrameId = 0;

      if (sourceTabId) {
        try {
          const updated = await chrome.tabs.update(sourceTabId, { url: result.roomState.movieUrl });
          state.activeTabId = updated?.id ?? sourceTabId;
        } catch {
          const tab = await chrome.tabs.create({ url: result.roomState.movieUrl });
          state.activeTabId = tab.id;
        }
      } else {
        const tab = await chrome.tabs.create({ url: result.roomState.movieUrl });
        state.activeTabId = tab.id;
      }

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
      const newMode =
        state.roomState.syncMode === "SYNC" ? "INDEPENDENT" : "SYNC";
      state.roomState.syncMode = newMode;
      await saveState();
      sendWsEvent({
        roomId: state.roomState.roomId,
        userId: state.userId,
        type: "MODE_CHANGE",
        syncMode: newMode,
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
      const newControl =
        state.roomState.controlMode === "OWNER" ? "SHARED" : "OWNER";
      state.roomState.controlMode = newControl;
      await saveState();
      sendWsEvent({
        roomId: state.roomState.roomId,
        userId: state.userId,
        type: "MODE_CHANGE",
        controlMode: newControl,
      });
      sendResponse({ controlMode: newControl });
      broadcastToPopup({ type: "STATE_UPDATE", payload: state });
      break;
    }

    case "VIDEO_EVENT": {
      const event: WatchEvent = message.payload;
      if (!state.roomState) return;

      const { syncMode, controlMode, ownerId } = state.roomState;

      if (syncMode === "INDEPENDENT") return;
      if (controlMode === "OWNER" && state.userId !== ownerId) return;

      sendWsEvent({ ...event, userId: state.userId, roomId: state.roomState.roomId });
      break;
    }

    case "APPLY_REMOTE_EVENT": {
      const { currentTime, playing, playbackRate, hasVideo } = message.payload || {};
      if (!state.roomState) return;
      if (hasVideo === false) return;

      sendWsEvent({
        roomId: state.roomState.roomId,
        userId: state.userId,
        type: "HEARTBEAT",
        currentTime,
        playing,
        playbackRate,
      });
      break;
    }

    default:
      sendResponse({ error: `Unknown message type: ${message.type}` });
  }
}

// ─── Handle room join from webapp URL ────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    const match = tab.url.match(/\/room\/([A-Z0-9]+)\/?$/i);
    if (match) {
      const roomId = match[1].toUpperCase();
      if (!state.roomState || state.roomState.roomId !== roomId) {
        chrome.tabs.sendMessage(tabId, {
          type: "TRIGGER_JOIN",
          payload: { roomId, sourceTabId: tabId },
        }).catch(() => {});
      }
    }
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  await initConfig();

  await loadState();
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
})();
