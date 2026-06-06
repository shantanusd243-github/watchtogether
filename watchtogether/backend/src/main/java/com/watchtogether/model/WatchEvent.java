package com.watchtogether.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonInclude(JsonInclude.Include.NON_NULL)
public class WatchEvent {

    private String roomId;
    private String userId;
    private EventType type;
    private Double currentTime;
    private Boolean playing;
    private Double playbackRate;
    private Boolean hasVideo;
    private Room.SyncMode syncMode;
    private Room.ControlMode controlMode;
    private String movieUrl;
    private Long timestamp;
    private ChatMessage chat;

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    @Builder
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static class ChatMessage {
        private String id;
        private String roomId;
        private String userId;
        private String displayName;
        private String text;
        private boolean gif;
        private long timestamp;
    }

    public enum EventType {
        PLAY,
        PAUSE,
        SEEK,
        SPEED,
        MODE_CHANGE,
        HEARTBEAT,
        JOIN,
        LEAVE,
        OWNER_CHANGE,
        ROOM_STATE,
        CHAT_MESSAGE,
        UPDATE_URL
    }
}
