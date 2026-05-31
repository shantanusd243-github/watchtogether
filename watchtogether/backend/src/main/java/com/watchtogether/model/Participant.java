package com.watchtogether.model;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class Participant {
    private String userId;
    private long joinedAt = Instant.now().toEpochMilli();
    private double currentTime = 0.0;
    private boolean playing = false;
    private long lastSeen = Instant.now().toEpochMilli();

    public Participant(String userId) {
        this.userId = userId;
    }

    public void updateHeartbeat(double currentTime, boolean playing) {
        this.currentTime = currentTime;
        this.playing = playing;
        this.lastSeen = Instant.now().toEpochMilli();
    }
}
