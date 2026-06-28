package signaling

import "encoding/json"

// Direction: c2s = client → server, s2c = server → client.
// Message envelope used on the WebSocket. `Payload` carries the type-specific
// JSON object, and `ReqID` lets the client correlate responses (used for SDP
// exchange and any other request/response pattern).
type Envelope struct {
	Type    string          `json:"type"`
	ReqID   string          `json:"reqId,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// === Payload structs ===========================================================

// Room mode constants. Determines participant cap and broadcast semantics.
const (
	RoomModeMeeting = "meeting" // many-to-many video conference (default)
	RoomModeCall    = "call"    // strictly 1:1, capacity = 2
	RoomModeSolo    = "solo"    // single-client publish or play; no broadcast
)

// Solo business role (mode=solo only). Distinct from whether media is publishing.
const (
	SoloRolePush = "push"
	SoloRolePlay = "play"
)

// c2s join: client identifies itself and the room it wants to enter.
type JoinPayload struct {
	Room     string `json:"room"`
	Nickname string `json:"nickname"`
	Mode     string `json:"mode,omitempty"`     // meeting | call | solo (default meeting)
	SoloRole string `json:"soloRole,omitempty"` // push | play when mode=solo
	StreamID string `json:"streamId,omitempty"` // intended/published stream in solo push
	Token    string `json:"token,omitempty"`
	MicOn    *bool  `json:"micOn,omitempty"`
	CamOn    *bool  `json:"camOn,omitempty"`
	// ClientPlatform helps viewers correct camera mirroring (ios | android | desktop).
	ClientPlatform string `json:"clientPlatform,omitempty"`
}

// s2c joined: confirms join + lists existing peers (and their published streams).
type PeerInfo struct {
	UserID   string `json:"userId"`
	Nickname string `json:"nickname"`
	MicOn    bool   `json:"micOn"`
	CamOn    bool   `json:"camOn"`
	// ClientPlatform is the publisher client OS family (ios | android | desktop).
	ClientPlatform string `json:"clientPlatform,omitempty"`
	// StreamIDs the peer is currently publishing (e.g. "cam", "screen").
	Streams []StreamInfo `json:"streams"`
}

type StreamInfo struct {
	Kind     string `json:"kind"`     // "cam" or "screen"
	StreamID string `json:"streamId"` // full ZLM stream name
}

// PullBrief describes one active pull session on a client.
type PullBrief struct {
	Kind         string `json:"kind"`
	StreamID     string `json:"streamId"`
	TargetUserID string `json:"targetUserId,omitempty"`
}

// MemberRow is one admin member-list entry (publish or pull).
type MemberRow struct {
	Biz          string `json:"biz"`
	RoomID       string `json:"roomId"`
	RoomDisplay  string `json:"roomDisplay"`
	UserID       string `json:"userId"`
	Nickname     string `json:"nickname"`
	StreamKind   string `json:"streamKind,omitempty"`
	StreamID     string `json:"streamId,omitempty"`
	StreamLabel  string `json:"streamLabel"`
	StreamOnline bool   `json:"streamOnline"`
	Recording    bool   `json:"recording"`
	ClientPlatform string `json:"clientPlatform,omitempty"`
}

type JoinedPayload struct {
	UserID string     `json:"userId"`
	Room   string     `json:"room"`
	Peers  []PeerInfo `json:"peers"`
}

// s2c peer-joined: a new peer joined the room (no streams yet).
type PeerJoinedPayload struct {
	UserID   string `json:"userId"`
	Nickname string `json:"nickname"`
	MicOn    bool   `json:"micOn"`
	CamOn    bool   `json:"camOn"`
	ClientPlatform string `json:"clientPlatform,omitempty"`
}

// s2c peer-left
type PeerLeftPayload struct {
	UserID string `json:"userId"`
}

// c2s media-state: the local user toggled mic/cam.
type MediaStatePayload struct {
	MicOn bool `json:"micOn"`
	CamOn bool `json:"camOn"`
}

// s2c peer-state: another peer's mic/cam state changed.
type PeerStatePayload struct {
	UserID string `json:"userId"`
	MicOn  bool   `json:"micOn"`
	CamOn  bool   `json:"camOn"`
}

// c2s/s2c chat
type ChatPayload struct {
	From     string `json:"from,omitempty"`     // userId, set by server when broadcasting
	Nickname string `json:"nickname,omitempty"` // set by server
	Text     string `json:"text"`
	TS       int64  `json:"ts,omitempty"` // unix millis, set by server
}

// c2s webrtc-offer: ask the server to negotiate a publish or play session
// with ZLM on behalf of this user.
//   - For "publish": kind is "cam" or "screen"; the published stream id is
//     derived as <room>__<userId>__<kind>. targetUserId is empty.
//   - For "play": targetUserId + kind identify which remote stream to pull.
//   - For "publish-solo": client supplies StreamID directly (independent push).
//   - For "play-solo": client supplies StreamID directly (independent pull).
type WebRTCOfferPayload struct {
	Mode         string `json:"mode"` // "publish" | "play" | "publish-solo" | "play-solo"
	Kind         string `json:"kind"` // "cam" | "screen" (ignored for solo)
	TargetUserID string `json:"targetUserId,omitempty"`
	StreamID     string `json:"streamId,omitempty"` // required for solo modes
	SDP          string `json:"sdp"`
}

// s2c webrtc-answer
type WebRTCAnswerPayload struct {
	Mode         string `json:"mode"`
	Kind         string `json:"kind"`
	TargetUserID string `json:"targetUserId,omitempty"`
	StreamID     string `json:"streamId"`
	SDP          string `json:"sdp"`
}

// c2s stream-started: client just finished publishing a stream and lets the
// server broadcast it so other peers can pull it.
type StreamStartedPayload struct {
	Kind     string `json:"kind"`
	StreamID string `json:"streamId"`
}

// c2s stream-stopped: client stopped publishing a stream (typically screen
// share). Server closes the stream on ZLM and broadcasts to peers.
type StreamStoppedPayload struct {
	Kind     string `json:"kind"`
	StreamID string `json:"streamId"`
}

// s2c peer-stream-started / peer-stream-stopped: someone else's stream
// appeared / disappeared.
type PeerStreamPayload struct {
	UserID   string `json:"userId"`
	Kind     string `json:"kind"`
	StreamID string `json:"streamId"`
}

// s2c error
type ErrorPayload struct {
	Message string `json:"message"`
}

// c2s record-start / record-stop: client asks the server to start/stop ZLM
// recording for a stream they own.
//   - In meeting/call mode, pass `kind` ("cam" or "screen"); the server looks
//     up the corresponding streamId from the client's published streams.
//   - In solo mode, pass `streamId` directly.
type RecordControlPayload struct {
	Kind     string `json:"kind,omitempty"`
	StreamID string `json:"streamId,omitempty"`
}

// s2c record-state: broadcasted to the room when a stream's recording state
// changes; also sent as an ack to the controlling client.
// RecordFileURL is only populated in the ack (stop → the recorded file).
type RecordStatePayload struct {
	UserID        string `json:"userId,omitempty"`
	Kind          string `json:"kind,omitempty"`
	StreamID      string `json:"streamId"`
	Recording     bool   `json:"recording"`
	RecordFileURL string `json:"recordFileUrl,omitempty"`
}

// Message type constants.
const (
	// client → server
	TypeJoin          = "join"
	TypeLeave         = "leave"
	TypeChat          = "chat"
	TypeMediaState    = "media-state"
	TypeWebRTCOffer   = "webrtc-offer"
	TypeStreamStarted = "stream-started"
	TypeStreamStopped = "stream-stopped"
	TypeRecordStart   = "record-start"
	TypeRecordStop    = "record-stop"
	TypeObserveJoin       = "observe-join"
	TypeObserveLeave      = "observe-leave"
	TypeObserveWatchStop  = "observe-watch-stop"

	// server → client
	TypeJoined            = "joined"
	TypePeerJoined        = "peer-joined"
	TypePeerLeft          = "peer-left"
	TypePeerState         = "peer-state"
	TypeWebRTCAnswer      = "webrtc-answer"
	TypePeerStreamStarted = "peer-stream-started"
	TypePeerStreamStopped = "peer-stream-stopped"
	TypeRecordState       = "record-state"
	TypeObserveJoined     = "observe-joined"
	TypeObserveEnded      = "observe-ended"
	TypeObserveError      = "observe-error"
	TypeAdminKicked       = "admin-kicked"
	TypeError             = "error"
)

// AdminKickedPayload is sent when an admin force-removes a business client.
type AdminKickedPayload struct {
	Message string `json:"message,omitempty"`
}

// ObserveJoinPayload is sent by admin clients to enter a room as a silent observer.
type ObserveJoinPayload struct {
	Room string `json:"room"`
	Mode string `json:"mode"` // meeting | call | solo
}

// ObserveWatchStopPayload reports that the admin stopped watching a member stream.
type ObserveWatchStopPayload struct {
	Detail string `json:"detail"`
}

// ObserveEndedPayload is sent when the watched business ends.
type ObserveEndedPayload struct {
	Message string `json:"message,omitempty"`
}
