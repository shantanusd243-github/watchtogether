package com.watchtogether.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.watchtogether.model.Room;
import com.watchtogether.model.WatchEvent;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.*;

import java.io.IOException;
import java.net.URI;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

@Component
@RequiredArgsConstructor
@Slf4j
public class WatchTogetherWebSocketHandler implements WebSocketHandler {

    private final RoomService roomService;
    private final ObjectMapper objectMapper;

    // roomId -> list of sessions
    private final Map<String, List<WebSocketSession>> roomSessions = new ConcurrentHashMap<>();
    // sessionId -> roomId
    private final Map<String, String> sessionRoom = new ConcurrentHashMap<>();
    // sessionId -> userId
    private final Map<String, String> sessionUser = new ConcurrentHashMap<>();

    // ── Connection Lifecycle ─────────────────────────────────────────────

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        String roomId = extractPathParam(session.getUri(), "room");
        String userId = extractQueryParam(session.getUri(), "userId");

        if (roomId == null || userId == null) {
            session.close(CloseStatus.BAD_DATA);
            return;
        }

        Optional<Room> roomOpt = roomService.getRoom(roomId);
        if (roomOpt.isEmpty()) {
            session.close(CloseStatus.NOT_ACCEPTABLE.withReason("Room not found"));
            return;
        }

        sessionRoom.put(session.getId(), roomId);
        sessionUser.put(session.getId(), userId);
        roomSessions.computeIfAbsent(roomId, k -> new CopyOnWriteArrayList<>()).add(session);

        log.info("WS connected: user={} room={} session={}", userId, roomId, session.getId());

        // Send current room state to the newly connected client
        Room room = roomOpt.get();
        WatchEvent stateEvent = WatchEvent.builder()
            .type(WatchEvent.EventType.ROOM_STATE)
            .roomId(roomId)
            .userId("server")
            .syncMode(room.getSyncMode())
            .controlMode(room.getControlMode())
            .timestamp(Instant.now().toEpochMilli())
            .build();
        sendToSession(session, stateEvent);

        // Notify other participants
        WatchEvent joinEvent = WatchEvent.builder()
            .type(WatchEvent.EventType.JOIN)
            .roomId(roomId)
            .userId(userId)
            .timestamp(Instant.now().toEpochMilli())
            .build();
        broadcastToRoom(roomId, joinEvent, session.getId());
    }

    @Override
    public void handleMessage(WebSocketSession session, WebSocketMessage<?> message) throws Exception {
        if (!(message instanceof TextMessage textMessage)) return;

        String roomId = sessionRoom.get(session.getId());
        String userId = sessionUser.get(session.getId());
        if (roomId == null || userId == null) return;

        WatchEvent event;
        try {
            event = objectMapper.readValue(textMessage.getPayload(), WatchEvent.class);
        } catch (Exception e) {
            log.warn("Failed to parse WS message from {}: {}", userId, e.getMessage());
            return;
        }

        // Always stamp the server-side userId and timestamp
        event.setUserId(userId);
        event.setRoomId(roomId);
        event.setTimestamp(Instant.now().toEpochMilli());

        processEvent(session, event, roomId, userId);
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.warn("WS transport error for session {}: {}", session.getId(), exception.getMessage());
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        String roomId = sessionRoom.remove(session.getId());
        String userId = sessionUser.remove(session.getId());

        if (roomId != null) {
            List<WebSocketSession> sessions = roomSessions.get(roomId);
            if (sessions != null) {
                sessions.remove(session);
                if (sessions.isEmpty()) roomSessions.remove(roomId);
            }

            if (userId != null) {
                try {
                    roomService.leaveRoom(roomId, userId);
                } catch (NoSuchElementException ignored) {}

                WatchEvent leaveEvent = WatchEvent.builder()
                    .type(WatchEvent.EventType.LEAVE)
                    .roomId(roomId)
                    .userId(userId)
                    .timestamp(Instant.now().toEpochMilli())
                    .build();
                broadcastToRoom(roomId, leaveEvent, session.getId());
            }
        }
        log.info("WS disconnected: session={} status={}", session.getId(), status);
    }

    @Override
    public boolean supportsPartialMessages() {
        return false;
    }

    // ── Event Processing ─────────────────────────────────────────────────

    private void processEvent(WebSocketSession session, WatchEvent event, String roomId, String userId) {
        Optional<Room> roomOpt = roomService.getRoom(roomId);
        if (roomOpt.isEmpty()) return;
        Room room = roomOpt.get();

        switch (event.getType()) {
            case PLAY, PAUSE, SEEK, SPEED -> {
                // In OWNER control mode, only owner can broadcast these
                if (room.getControlMode() == Room.ControlMode.OWNER
                    && !room.getOwnerId().equals(userId)) {
                    log.debug("Blocked {} event from non-owner {} in room {}", event.getType(), userId, roomId);
                    return;
                }
                if (room.getSyncMode() == Room.SyncMode.SYNC) {
                    broadcastToRoom(roomId, event, session.getId());
                }
            }

            case HEARTBEAT -> {
                if (event.getCurrentTime() != null && event.getPlaying() != null) {
                    roomService.updateHeartbeat(roomId, userId, event.getCurrentTime(), event.getPlaying());
                }
                if (room.getSyncMode() == Room.SyncMode.SYNC) {
                    broadcastToRoom(roomId, event, session.getId());
                }
            }

            case MODE_CHANGE -> {
                if (event.getSyncMode() != null) {
                    roomService.setSyncMode(roomId, event.getSyncMode());
                }
                if (event.getControlMode() != null) {
                    // Only owner can change control mode
                    if (room.getOwnerId().equals(userId)) {
                        roomService.setControlMode(roomId, event.getControlMode());
                    } else {
                        log.warn("Non-owner {} attempted to change control mode in room {}", userId, roomId);
                        return;
                    }
                }
                broadcastToRoom(roomId, event, null); // broadcast to ALL including sender
            }

            case CHAT_MESSAGE -> {
                // Chat goes to everyone in the room including sender
                broadcastToRoom(roomId, event, null);
            }

            default -> log.debug("Unhandled event type: {}", event.getType());
        }
    }

    // ── Broadcast Helpers ─────────────────────────────────────────────────

    public void broadcastToRoom(String roomId, WatchEvent event, String excludeSessionId) {
        List<WebSocketSession> sessions = roomSessions.getOrDefault(roomId, Collections.emptyList());
        String payload;
        try {
            payload = objectMapper.writeValueAsString(event);
        } catch (Exception e) {
            log.error("Failed to serialize event: {}", e.getMessage());
            return;
        }

        for (WebSocketSession s : sessions) {
            if (s.getId().equals(excludeSessionId)) continue;
            if (!s.isOpen()) continue;
            sendRaw(s, payload);
        }
    }

    private void sendToSession(WebSocketSession session, WatchEvent event) {
        try {
            String payload = objectMapper.writeValueAsString(event);
            sendRaw(session, payload);
        } catch (Exception e) {
            log.error("Failed to send event to session: {}", e.getMessage());
        }
    }

    private void sendRaw(WebSocketSession session, String payload) {
        try {
            synchronized (session) {
                if (session.isOpen()) {
                    session.sendMessage(new TextMessage(payload));
                }
            }
        } catch (IOException e) {
            log.warn("Failed to send message to session {}: {}", session.getId(), e.getMessage());
        }
    }

    // ── URI Parsing ───────────────────────────────────────────────────────

    private String extractPathParam(URI uri, String param) {
        if (uri == null) return null;
        String path = uri.getPath();
        // Path pattern: /ws/room/{roomId}
        String[] parts = path.split("/");
        for (int i = 0; i < parts.length - 1; i++) {
            if (parts[i].equals(param)) return parts[i + 1];
        }
        return null;
    }

    private String extractQueryParam(URI uri, String param) {
        if (uri == null || uri.getQuery() == null) return null;
        for (String part : uri.getQuery().split("&")) {
            String[] kv = part.split("=", 2);
            if (kv.length == 2 && kv[0].equals(param)) return kv[1];
        }
        return null;
    }
}
