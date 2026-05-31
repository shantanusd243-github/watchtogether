package com.watchtogether.model;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

public class Dto {

    @Data
    public static class CreateRoomRequest {
        @NotBlank
        private String movieUrl;

        @NotBlank
        private String userId;
    }

    @Data
    public static class JoinRoomRequest {
        @NotBlank
        private String userId;
    }

    @Data
    public static class LeaveRoomRequest {
        @NotBlank
        private String userId;
    }

    @Data
    public static class CreateRoomResponse {
        private String roomId;
        private String shareUrl;
        private String userId;

        public CreateRoomResponse(String roomId, String shareUrl, String userId) {
            this.roomId = roomId;
            this.shareUrl = shareUrl;
            this.userId = userId;
        }
    }

    @Data
    public static class JoinRoomResponse {
        private String roomId;
        private Room roomState;
        private String userId;

        public JoinRoomResponse(String roomId, Room roomState, String userId) {
            this.roomId = roomId;
            this.roomState = roomState;
            this.userId = userId;
        }
    }
}
