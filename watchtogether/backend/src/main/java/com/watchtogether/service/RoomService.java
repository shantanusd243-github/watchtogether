package com.watchtogether.service;

import com.watchtogether.model.Participant;
import com.watchtogether.model.Room;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

@Service
@Slf4j
public class RoomService {

    private static final long ROOM_EXPIRY_MS = 6 * 60 * 60 * 1000L; // 6 hours
    private static final long PARTICIPANT_STALE_MS = 2 * 60 * 60 * 1000L; // 2 hours

    private final Map<String, Room> rooms = new ConcurrentHashMap<>();

    // ── Room ID generation ──────────────────────────────────────────────────

    public String generateRoomId() {
        String id;
        do {
            id = randomAlphanumeric(6);
        } while (rooms.containsKey(id));
        return id;
    }

    private String randomAlphanumeric(int length) {
        String chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
        Random rng = new Random();
        StringBuilder sb = new StringBuilder(length);
        for (int i = 0; i < length; i++) {
            sb.append(chars.charAt(rng.nextInt(chars.length())));
        }
        return sb.toString();
    }

    // ── CRUD ──────────────────────────────────────────────────────────────

    public Room createRoom(String movieUrl, String ownerId) {
        String roomId = generateRoomId();
        Room room = new Room(roomId, movieUrl, ownerId);
        room.addParticipant(new Participant(ownerId));
        rooms.put(roomId, room);
        log.info("Room created: {} by {}", roomId, ownerId);
        return room;
    }

    public Optional<Room> getRoom(String roomId) {
        return Optional.ofNullable(rooms.get(roomId));
    }

    public Room joinRoom(String roomId, String userId) {
        Room room = rooms.get(roomId);
        if (room == null) throw new NoSuchElementException("Room not found: " + roomId);
        room.addParticipant(new Participant(userId));
        log.info("User {} joined room {}", userId, roomId);
        return room;
    }

    public Room leaveRoom(String roomId, String userId) {
        Room room = rooms.get(roomId);
        if (room == null) throw new NoSuchElementException("Room not found: " + roomId);
        room.removeParticipant(userId);
        log.info("User {} left room {}", userId, roomId);

        // If owner left, transfer ownership
        if (userId.equals(room.getOwnerId()) && !room.isEmpty()) {
            String newOwner = room.getParticipants().get(0).getUserId();
            room.setOwnerId(newOwner);
            log.info("Ownership transferred to {} in room {}", newOwner, roomId);
        }

        if (room.isEmpty()) {
            rooms.remove(roomId);
            log.info("Room {} removed (empty)", roomId);
        }
        return room;
    }

    public void updateHeartbeat(String roomId, String userId, double currentTime, boolean playing) {
        Room room = rooms.get(roomId);
        if (room == null) return;
        room.getParticipants().stream()
            .filter(p -> p.getUserId().equals(userId))
            .findFirst()
            .ifPresent(p -> p.updateHeartbeat(currentTime, playing));
    }

    public void setSyncMode(String roomId, Room.SyncMode syncMode) {
        Room room = rooms.get(roomId);
        if (room != null) room.setSyncMode(syncMode);
    }

    public void setControlMode(String roomId, Room.ControlMode controlMode) {
        Room room = rooms.get(roomId);
        if (room != null) room.setControlMode(controlMode);
    }

    public boolean isOwner(String roomId, String userId) {
        return getRoom(roomId)
            .map(r -> r.getOwnerId().equals(userId))
            .orElse(false);
    }

    public Collection<Room> getAllRooms() {
        return rooms.values();
    }

    // ── Scheduled cleanup ─────────────────────────────────────────────────

    @Scheduled(fixedDelay = 60_000)
    public void cleanupStaleRooms() {
        long cutoff = Instant.now().toEpochMilli() - ROOM_EXPIRY_MS;
        rooms.entrySet().removeIf(entry -> {
            Room room = entry.getValue();
            if (room.getCreatedAt() < cutoff || room.isEmpty()) {
                log.info("Removing stale room: {}", entry.getKey());
                return true;
            }
            return false;
        });
    }

    @Scheduled(fixedDelay = 15_000)
    public void cleanupStaleParticipants() {
        long cutoff = Instant.now().toEpochMilli() - PARTICIPANT_STALE_MS;
        for (Room room : rooms.values()) {
            room.getParticipants().removeIf(p -> p.getLastSeen() < cutoff);
        }
    }
}
