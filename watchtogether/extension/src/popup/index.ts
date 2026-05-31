import type {
  InternalMessage,
  ExtensionState,
  RoomState,
} from "../types/index";

const APP_BASE = "http://localhost:5173";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function send(msg: InternalMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(response);
    });
  });
}

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────
function showLoading(text = "Loading…"): void {
  ($("view-loading") as HTMLElement).classList.remove("hidden");
  ($("view-home") as HTMLElement).classList.add("hidden");
  ($("view-room") as HTMLElement).classList.add("hidden");
  ($("loading-text") as HTMLElement).textContent = text;
}

function showHome(): void {
  ($("view-loading") as HTMLElement).classList.add("hidden");
  ($("view-home") as HTMLElement).classList.remove("hidden");
  ($("view-room") as HTMLElement).classList.add("hidden");
  clearError();
}

function showRoom(state: ExtensionState): void {
  ($("view-loading") as HTMLElement).classList.add("hidden");
  ($("view-home") as HTMLElement).classList.add("hidden");
  ($("view-room") as HTMLElement).classList.remove("hidden");
  if (state.roomState) {
    updateRoomUI(state);
  }
}

function showError(msg: string): void {
  const el = $("error-msg");
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 5000);
}

function clearError(): void {
  $("error-msg").classList.add("hidden");
}

function updateRoomUI(state: ExtensionState): void {
  const room = state.roomState!;
  ($("room-id-display") as HTMLElement).textContent = room.roomId;
  ($("user-count") as HTMLElement).textContent = String(
    room.participants?.length ?? 1
  );

  const shareUrl = `${APP_BASE}/room/${room.roomId}`;
  ($("share-url-display") as HTMLElement).textContent = shareUrl;
  ($("movie-url-display") as HTMLElement).textContent = room.movieUrl ?? "—";

  // Sync mode pill
  const isSynced = room.syncMode === "SYNC";
  const pillSync = $("pill-sync");
  pillSync.classList.toggle("active", isSynced);
  pillSync.classList.toggle("sync", isSynced);
  ($("sync-mode-label") as HTMLElement).textContent = room.syncMode;

  // Control mode pill
  const isOwnerMode = room.controlMode === "OWNER";
  const pillControl = $("pill-control");
  const isOwner = state.userId === room.ownerId;
  pillControl.classList.toggle("active", isOwnerMode);
  pillControl.style.opacity = isOwner ? "1" : "0.5";
  pillControl.style.cursor = isOwner ? "pointer" : "not-allowed";
  ($("control-mode-label") as HTMLElement).textContent = room.controlMode;

  // WS badge
  const badge = $("ws-badge");
  badge.classList.toggle("connected", state.wsConnected);
  badge.classList.toggle("disconnected", !state.wsConnected);
}

// ─── Actions ──────────────────────────────────────────────────────────────────
async function createRoom(): Promise<void> {
  const url = ($("movie-url") as HTMLInputElement).value.trim();
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
    // State will be updated via message listener
  } catch (e: any) {
    showHome();
    showError(e.message ?? "Failed to create room.");
  }
}

async function joinRoom(): Promise<void> {
  const roomId = ($("join-room-id") as HTMLInputElement).value
    .trim()
    .toUpperCase();
  if (!roomId) {
    showError("Please enter a Room ID.");
    return;
  }

  showLoading("Joining room…");
  try {
    const res = await send({ type: "JOIN_ROOM", payload: { roomId } });
    if (res.error) throw new Error(res.error);
  } catch (e: any) {
    showHome();
    showError(e.message ?? "Failed to join room.");
  }
}

async function leaveRoom(): Promise<void> {
  showLoading("Leaving…");
  armLoadingWatchdog(); // recover if STATE_UPDATE never arrives
  await send({ type: "LEAVE_ROOM" });
  // Do NOT call showHome() here — background's resetLocalState() already
  // broadcasts STATE_UPDATE which the listener below handles. Calling
  // showHome() here too causes a double-render race on slow connections.
}

async function toggleSyncMode(): Promise<void> {
  try {
    await send({ type: "TOGGLE_SYNC_MODE" });
  } catch (e: any) {
    showError(e.message ?? "Failed to toggle sync mode.");
  }
}

async function toggleControlMode(): Promise<void> {
  try {
    const res = await send({ type: "TOGGLE_CONTROL_MODE" });
    if (res.error) showError(res.error);
  } catch (e: any) {
    showError(e.message ?? "Failed to toggle control mode.");
  }
}

function copyShareUrl(): void {
  const el = $("share-url-display");
  const url = el.textContent ?? "";
  if (!url || url === "—") return;
  navigator.clipboard.writeText(url).then(() => {
    const btn = $("copy-btn") as HTMLButtonElement;
    btn.textContent = "✓ Copied";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = "Copy";
      btn.classList.remove("copied");
    }, 2000);
  });
}

// ─── Message Listener (from background) ──────────────────────────────────────
chrome.runtime.onMessage.addListener((message: InternalMessage) => {
  switch (message.type) {
    case "STATE_UPDATE":
      const extState = message.payload as ExtensionState;
      if (extState.roomState) {
        showRoom(extState);
      } else {
        showHome();
      }
      break;
    case "WS_CONNECTED":
    case "WS_DISCONNECTED":
      // Re-fetch state to update badge
      refreshState();
      break;
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
async function refreshState(): Promise<void> {
  try {
    const res = await send({ type: "GET_STATE" });
    const extState: ExtensionState = res.state;
    if (extState.roomState) {
      showRoom(extState);
    } else {
      showHome();
    }
    const badge = $("ws-badge");
    badge.classList.toggle("connected", extState.wsConnected);
    badge.classList.toggle("disconnected", !extState.wsConnected);
  } catch {
    // Background service worker not reachable or returned nothing
    showHome();
  }
}

// Safety net: if the popup is stuck on the loading screen (e.g. leaveRoom
// fired but STATE_UPDATE from background never arrived), auto-recover after
// 4 seconds by re-fetching state directly.
let loadingWatchdog: ReturnType<typeof setTimeout> | null = null;
function armLoadingWatchdog(): void {
  if (loadingWatchdog) clearTimeout(loadingWatchdog);
  loadingWatchdog = setTimeout(() => {
    const loadingEl = $("view-loading");
    if (!loadingEl.classList.contains("hidden")) {
      console.warn("[WatchTogether Popup] Stuck on loading — recovering via GET_STATE");
      refreshState();
    }
  }, 4000);
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
    (e.target as HTMLInputElement).value = (
      e.target as HTMLInputElement
    ).value.toUpperCase();
  });
  refreshState();
});
