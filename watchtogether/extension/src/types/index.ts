// ─── Sync Modes ──────────────────────────────────────────────────────────────
export type SyncMode = "SYNC" | "INDEPENDENT";
export type ControlMode = "OWNER" | "SHARED";

// ─── Event Types ─────────────────────────────────────────────────────────────
export type EventType =
  | "PLAY"
  | "PAUSE"
  | "SEEK"
  | "SPEED"
  | "MODE_CHANGE"
  | "HEARTBEAT"
  | "JOIN"
  | "LEAVE"
  | "OWNER_CHANGE";

// ─── WebSocket Messages ───────────────────────────────────────────────────────
export interface WatchEvent {
  roomId: string;
  userId: string;
  type: EventType;
  currentTime?: number;
  playing?: boolean;
  playbackRate?: number;
  hasVideo?: boolean;
  syncMode?: SyncMode;
  controlMode?: ControlMode;
  movieUrl?: string;
  timestamp?: number;
}

export interface HeartbeatEvent extends WatchEvent {
  type: "HEARTBEAT";
  currentTime: number;
  playing: boolean;
}

// ─── Room State ───────────────────────────────────────────────────────────────
export interface RoomState {
  roomId: string;
  movieUrl: string;
  syncMode: SyncMode;
  controlMode: ControlMode;
  ownerId: string;
  participants: Participant[];
  createdAt: number;
}

export interface Participant {
  userId: string;
  joinedAt: number;
  currentTime?: number;
  isPlaying?: boolean;
  lastSeen?: number;
}

// ─── Extension Internal Messages ─────────────────────────────────────────────
export type InternalMessageType =
  | "CREATE_ROOM"
  | "JOIN_ROOM"
  | "LEAVE_ROOM"
  | "OPEN_MOVIE"
  | "GET_STATE"
  | "TRIGGER_JOIN"
  | "TOGGLE_SYNC_MODE"
  | "TOGGLE_CONTROL_MODE"
  | "VIDEO_EVENT"
  | "APPLY_REMOTE_EVENT"
  | "ROOM_CREATED"
  | "ROOM_JOINED"
  | "STATE_UPDATE"
  | "WS_CONNECTED"
  | "WS_DISCONNECTED"
  | "ERROR";

export interface InternalMessage {
  type: InternalMessageType;
  payload?: any;
  error?: string;
}

export interface ExtensionState {
  connected: boolean;
  roomState: RoomState | null;
  userId: string;
  activeTabId?: number;
  activeFrameId?: number;
  wsConnected: boolean;
}

// ─── API Responses ────────────────────────────────────────────────────────────
export interface CreateRoomResponse {
  roomId: string;
  shareUrl: string;
  userId: string;
}

export interface JoinRoomResponse {
  roomId: string;
  roomState: RoomState;
  userId: string;
}
