# WatchTogether — Synchronized Streaming Platform

A Chrome Extension + Spring Boot backend that synchronizes movie playback across users watching on **their own streaming accounts**. No video is captured or redistributed.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        BROWSER (P1)                              │
│  ┌─────────────┐   ┌──────────────────┐   ┌──────────────────┐  │
│  │  Extension  │   │  Streaming Tab   │   │  Content Script  │  │
│  │   Popup     │◄──│  (Netflix etc.)  │──►│  Video listener  │  │
│  └──────┬──────┘   └──────────────────┘   └────────┬─────────┘  │
│         │                                           │            │
│  ┌──────▼──────────────────────────────────────────▼─────────┐  │
│  │                  Background Service Worker                  │  │
│  │        WebSocket client │ Room state │ Event routing        │  │
│  └──────────────────────────────┬──────────────────────────────┘  │
└─────────────────────────────────│────────────────────────────────┘
                                  │ WebSocket (ws://localhost:8080)
┌─────────────────────────────────│────────────────────────────────┐
│                    SPRING BOOT BACKEND                            │
│  ┌──────────────────┐   ┌───────────────────────────────────┐    │
│  │  REST Controller │   │    WebSocket Handler               │    │
│  │  POST /rooms     │   │  /ws/room/{roomId}?userId=...      │    │
│  │  GET  /rooms/:id │   │  - Session registry per room       │    │
│  │  POST /rooms/:id/│   │  - Event fan-out                   │    │
│  │       join/leave │   │  - Control mode enforcement        │    │
│  └──────────────────┘   └───────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │                    Room Service                          │     │
│  │   ConcurrentHashMap<roomId, Room>                        │     │
│  │   Participant tracking │ Heartbeat │ Scheduled cleanup   │     │
│  └─────────────────────────────────────────────────────────┘     │
└───────────────────────────────────────────────────────────────────┘
                                  │
┌─────────────────────────────────│────────────────────────────────┐
│                        BROWSER (P2)                              │
│              (same extension + content script setup)              │
└───────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
watchtogether/
├── extension/                    # Chrome Extension (TypeScript + Vite)
│   ├── src/
│   │   ├── types/index.ts        # Shared TypeScript types
│   │   ├── background/index.ts   # Service worker: WS + room management
│   │   ├── content/index.ts      # Video detection + event handling
│   │   └── popup/index.ts        # Popup UI logic
│   ├── public/
│   │   ├── manifest.json         # Manifest V3
│   │   ├── popup.html            # Popup UI
│   │   └── icons/                # Extension icons
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── package.json
│
├── backend/                      # Spring Boot 3.x + Java 21
│   ├── src/main/java/com/watchtogether/
│   │   ├── WatchTogetherApplication.java
│   │   ├── config/
│   │   │   ├── WebSocketConfig.java   # WS handler registration
│   │   │   └── CorsConfig.java        # CORS filter
│   │   ├── controller/
│   │   │   └── RoomController.java    # REST: create/join/leave
│   │   ├── model/
│   │   │   ├── Room.java
│   │   │   ├── Participant.java
│   │   │   ├── WatchEvent.java
│   │   │   └── Dto.java
│   │   └── service/
│   │       ├── RoomService.java              # In-memory room state
│   │       └── WatchTogetherWebSocketHandler.java  # WS fan-out
│   ├── src/main/resources/application.properties
│   └── pom.xml
│
└── webapp/                       # Minimal Vite web app (room landing page)
    ├── index.html                # Room join page for P2
    ├── vite.config.ts
    └── package.json
```

---

## WebSocket Message Protocol

All messages are JSON over raw WebSocket at `/ws/room/{roomId}?userId={userId}`.

### Event Types

| Type          | Direction        | Description                              |
|---------------|------------------|------------------------------------------|
| `PLAY`        | Client → Server → Other clients | User pressed play |
| `PAUSE`       | Client → Server → Other clients | User pressed pause |
| `SEEK`        | Client → Server → Other clients | User seeked to position |
| `HEARTBEAT`   | Client → Server → Other clients | Every 5s: current time + playing state |
| `MODE_CHANGE` | Client → Server → ALL clients   | Sync or control mode changed |
| `JOIN`        | Server → Other clients | New user joined room |
| `LEAVE`       | Server → Other clients | User left room |
| `ROOM_STATE`  | Server → New client | Full room state on connect |

### Example Payloads

```json
// PLAY event
{
  "roomId": "ABC123",
  "userId": "user_x7k2m",
  "type": "PLAY",
  "currentTime": 1847.3,
  "playing": true,
  "timestamp": 1712345678901
}

// SEEK event
{
  "roomId": "ABC123",
  "userId": "user_x7k2m",
  "type": "SEEK",
  "currentTime": 2735.52,
  "timestamp": 1712345678901
}

// HEARTBEAT (every 5s)
{
  "roomId": "ABC123",
  "userId": "user_x7k2m",
  "type": "HEARTBEAT",
  "currentTime": 1852.7,
  "playing": true,
  "timestamp": 1712345678901
}

// MODE_CHANGE
{
  "roomId": "ABC123",
  "userId": "user_x7k2m",
  "type": "MODE_CHANGE",
  "syncMode": "INDEPENDENT",
  "controlMode": "OWNER",
  "timestamp": 1712345678901
}
```

---

## REST API

| Method | Endpoint                 | Body                          | Response             |
|--------|--------------------------|-------------------------------|----------------------|
| POST   | `/api/rooms`             | `{movieUrl, userId}`          | `{roomId, shareUrl}` |
| GET    | `/api/rooms/:roomId`     | —                             | Room object          |
| POST   | `/api/rooms/:roomId/join`| `{userId}`                    | `{roomId, roomState}`|
| POST   | `/api/rooms/:roomId/leave`| `{userId}`                   | 204 No Content       |

---

## Sync & Drift Correction Logic

```
Content Script
  │
  ├── on play/pause/seeking → send VIDEO_EVENT to background
  │
  └── on timeupdate → track local position
  
Background Service Worker
  │
  ├── forwards events to WebSocket (if SYNC mode and allowed by control mode)
  │
  └── every 5 seconds → asks content script for currentTime
        → sends HEARTBEAT to server

Content Script (receiving remote events)
  │
  ├── PLAY: if drift > 1s, seek first; then play()
  ├── PAUSE: if drift > 0.5s, seek first; then pause()
  ├── SEEK: set currentTime directly
  └── HEARTBEAT: if drift > 1.0s, correct; check play/pause state

Loop prevention:
  isApplyingRemote = true
  → apply changes
  → setTimeout 300ms
  → isApplyingRemote = false
  (events fired during this window are ignored)
```

---

## Control Modes

| Mode     | Who can control | Use case                          |
|----------|-----------------|-----------------------------------|
| `SHARED` | Everyone        | Default — anyone can play/pause   |
| `OWNER`  | Room creator    | Avoid control conflicts; one person drives |

---

## Local Development Setup

### Prerequisites
- Java 21
- Maven 3.9+
- Node.js 20+
- Chrome browser

### 1. Start the Backend

```bash
cd backend
mvn spring-boot:run
# Backend starts on http://localhost:8080
```

### 2. Build the Extension

```bash
cd extension
npm install
npm run build
# Output in extension/dist/
```

To watch for changes:
```bash
npm run dev
```

### 3. Load Extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer Mode** (top right)
3. Click **Load unpacked**
4. Select `extension/dist/`

### 4. Start the Webapp

```bash
cd webapp
npm install
npm run dev
# Webapp on http://localhost:5173
```

---

## Usage Flow

### P1 (Host)
1. Click extension icon
2. Paste Netflix/Prime/Hotstar URL in **Movie URL** field
3. Click **Create Watch Room**
4. Extension opens the movie in a new tab + connects to backend
5. Copy the share URL shown in the popup (e.g. `http://localhost:5173/room/ABC123`)
6. Send this URL to P2

### P2 (Guest)
1. Open the shared URL in Chrome
2. See room info (participants, sync mode, movie domain)
3. Click **Join Watch Room**
4. Extension automatically opens the same movie and joins the room
5. Both users are now synchronized

---

## Production Deployment

### Backend (e.g. AWS EC2 / Railway / Render)

```bash
cd backend
mvn package -DskipTests
java -jar target/watchtogether-backend-1.0.0-SNAPSHOT.jar \
  --server.port=8080 \
  --watchtogether.cors.origins=https://your-domain.com
```

Or with Docker:
```dockerfile
FROM eclipse-temurin:21-jre
COPY target/watchtogether-backend-*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app.jar"]
```

### Webapp (e.g. Vercel / Netlify)

```bash
cd webapp
npm run build
# Deploy dist/ to your static host
```

Update the constants in:
- `extension/src/background/index.ts`: `API_BASE`, `WS_BASE`, `APP_BASE`
- `backend/src/main/java/.../controller/RoomController.java`: `APP_BASE`
- `webapp/index.html`: `API_BASE`

### Extension for Chrome Web Store

1. Update `manifest.json` host permissions to match your domain
2. Run `npm run build`
3. Zip `extension/dist/`
4. Upload to Chrome Web Store developer dashboard

---

## Security Notes

- The extension **never** accesses cookies, credentials, or video frames
- Only playback metadata (timestamp, play/pause state) is transmitted
- Users must be independently logged into streaming services
- All room data is in-memory; no database, no PII stored
- Rooms auto-expire after 6 hours of inactivity

---

## Adding New Features

### Persistent Storage (PostgreSQL)
Replace `ConcurrentHashMap` in `RoomService` with Spring Data JPA repositories.

### Authentication
Add Spring Security with JWT. Pass token as WebSocket query param.

### Chat
Add a `CHAT_MESSAGE` event type to `WatchEvent` and fan-out to room.

### Mobile (Safari)
Safari's WebExtensions API is compatible with Manifest V3. Build with the same source; distribute via Xcode.
