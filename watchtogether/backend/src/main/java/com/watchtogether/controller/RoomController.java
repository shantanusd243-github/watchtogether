package com.watchtogether.controller;

import com.watchtogether.model.Dto;
import com.watchtogether.model.Room;
import com.watchtogether.service.RoomService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.util.NoSuchElementException;

@RestController
@RequestMapping("/api/rooms")
@RequiredArgsConstructor
@Slf4j
public class RoomController {
    @Value("${watchtogether.app-base}")
    private String APP_BASE;

    private final RoomService roomService;

    // ── Create Room ───────────────────────────────────────────────────────

    @PostMapping
    public ResponseEntity<Dto.CreateRoomResponse> createRoom(
        @Valid @RequestBody Dto.CreateRoomRequest request
    ) {
        Room room = roomService.createRoom(request.getMovieUrl(), request.getUserId());
        String shareUrl = APP_BASE + "/room/" + room.getRoomId();
        return ResponseEntity
            .status(HttpStatus.CREATED)
            .body(new Dto.CreateRoomResponse(room.getRoomId(), shareUrl, request.getUserId()));
    }

    // ── Get Room ──────────────────────────────────────────────────────────

    @GetMapping("/{roomId}")
    public ResponseEntity<Room> getRoom(@PathVariable String roomId) {
        return roomService.getRoom(roomId)
            .map(ResponseEntity::ok)
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Room not found: " + roomId));
    }

    // ── Join Room ─────────────────────────────────────────────────────────

    @PostMapping("/{roomId}/join")
    public ResponseEntity<Dto.JoinRoomResponse> joinRoom(
        @PathVariable String roomId,
        @Valid @RequestBody Dto.JoinRoomRequest request
    ) {
        try {
            Room room = roomService.joinRoom(roomId, request.getUserId());
            return ResponseEntity.ok(new Dto.JoinRoomResponse(roomId, room, request.getUserId()));
        } catch (NoSuchElementException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, e.getMessage());
        }
    }

    // ── Leave Room ────────────────────────────────────────────────────────

    @PostMapping("/{roomId}/leave")
    public ResponseEntity<Void> leaveRoom(
        @PathVariable String roomId,
        @RequestBody Dto.LeaveRoomRequest request
    ) {
        try {
            roomService.leaveRoom(roomId, request.getUserId());
            return ResponseEntity.noContent().build();
        } catch (NoSuchElementException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, e.getMessage());
        }
    }

    // ── Health / Debug ────────────────────────────────────────────────────

    @GetMapping
    public ResponseEntity<?> listRooms() {
        return ResponseEntity.ok(roomService.getAllRooms());
    }
}
