package com.watchtogether.model;

import com.fasterxml.jackson.annotation.JsonIgnore;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

@Data
@NoArgsConstructor
public class Room {

    private String roomId;
    private String movieUrl;
    private SyncMode syncMode = SyncMode.SYNC;
    private ControlMode controlMode = ControlMode.SHARED;
    private String ownerId;
    private List<Participant> participants = new CopyOnWriteArrayList<>();
    private long createdAt = Instant.now().toEpochMilli();

    public Room(String roomId, String movieUrl, String ownerId) {
        this.roomId = roomId;
        this.movieUrl = movieUrl;
        this.ownerId = ownerId;
    }

    public void addParticipant(Participant p) {
        participants.removeIf(existing -> existing.getUserId().equals(p.getUserId()));
        participants.add(p);
    }

    public void removeParticipant(String userId) {
        participants.removeIf(p -> p.getUserId().equals(userId));
    }

    public boolean hasParticipant(String userId) {
        return participants.stream().anyMatch(p -> p.getUserId().equals(userId));
    }

    @JsonIgnore
    public boolean isEmpty() {
        return participants.isEmpty();
    }

    public enum SyncMode {
        SYNC, INDEPENDENT
    }

    public enum ControlMode {
        OWNER, SHARED
    }
}
