package zlm

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"zlm_meet/backend/pkg/config"
)

// defaultVhost is hard-coded because vhost multi-tenancy is out of scope for
// this project; the ZLM default is fine for every supported deployment.
const defaultVhost = "__defaultVhost__"

// Client wraps the subset of ZLMediaKit's REST API that the signaling server needs.
// The ZLM "app" is supplied per-call by the caller, mapped from the front-end
// "room" input, so it is not stored on the client.
type Client struct {
	cfg        config.ZLMConfig
	httpClient *http.Client
	hookCache  hookCache // ZLM on_record_mp4 hook notifications
}

func New(cfg config.ZLMConfig) *Client {
	return &Client{
		cfg:        cfg,
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// ── Hook record cache ──────────────────────────────────────────────────────────
// ZLMediaKit can be configured with hook.on_record_mp4 pointing to our
// /api/zlm-hook/record-mp4 endpoint. When a recording completes, ZLM posts the
// file metadata and we cache it. ResolveLatestRecordURL only reads this cache;
// it does not poll ZLM's getMp4RecordFile API.

type hookRecord struct {
	FullURL string    // complete playable HTTP URL (api_base + path)
	TS      time.Time
}

type hookCache struct {
	mu    sync.RWMutex
	items map[string]hookRecord // key: "app/stream"
}

// StoreHookRecord saves a ZLM on_record_mp4 notification so the file URL can
// be resolved immediately. callURL should be the complete playable URL
// (e.g. http://zlm:8081/record/live/pub/2026-06-21/file.mp4).
func (c *Client) StoreHookRecord(app, stream, callURL string) {
	c.hookCache.mu.Lock()
	defer c.hookCache.mu.Unlock()
	if c.hookCache.items == nil {
		c.hookCache.items = make(map[string]hookRecord)
	}
	key := app + "/" + stream
	c.hookCache.items[key] = hookRecord{FullURL: callURL, TS: time.Now()}
	if len(c.hookCache.items) > 128 {
		now := time.Now()
		for k, v := range c.hookCache.items {
			if now.Sub(v.TS) > 60*time.Second {
				delete(c.hookCache.items, k)
			}
		}
	}
}

// lookupHookRecord returns the cached hook URL, or "" if not found / stale.
func (c *Client) lookupHookRecord(app, stream string) (string, bool) {
	c.hookCache.mu.RLock()
	defer c.hookCache.mu.RUnlock()
	key := app + "/" + stream
	r, ok := c.hookCache.items[key]
	if !ok || time.Since(r.TS) > 30*time.Second {
		return "", false
	}
	return r.FullURL, true
}

// WebRTCType identifies whether SDP exchange is for browser publishing or playing.
type WebRTCType string

const (
	WebRTCPush WebRTCType = "push"
	WebRTCPlay WebRTCType = "play"
)

// webrtcResponse mirrors ZLM's /index/api/webrtc JSON response.
type webrtcResponse struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
	Type string `json:"type"`
	SDP  string `json:"sdp"`
	ID   string `json:"id"`
}

// ExchangeSDP performs a WebRTC SDP offer/answer exchange with ZLM and returns
// the answer SDP. `app` is the ZLM stream group (front-end "room") and
// `stream` is unique within that app.
func (c *Client) ExchangeSDP(rtcType WebRTCType, app, stream, offerSDP string) (string, error) {
	q := url.Values{}
	q.Set("app", app)
	q.Set("stream", stream)
	q.Set("type", string(rtcType))
	q.Set("vhost", defaultVhost)

	endpoint := strings.TrimRight(c.cfg.APIBase, "/") + "/index/api/webrtc?" + q.Encode()

	req, err := http.NewRequest(http.MethodPost, endpoint, strings.NewReader(offerSDP))
	if err != nil {
		return "", fmt.Errorf("build webrtc request: %w", err)
	}
	req.Header.Set("Content-Type", "application/sdp")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("call webrtc api: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read webrtc response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("zlm webrtc http %d: %s", resp.StatusCode, string(body))
	}

	var parsed webrtcResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("decode webrtc response: %w (raw=%s)", err, string(body))
	}
	if parsed.Code != 0 {
		return "", fmt.Errorf("zlm webrtc error code=%d msg=%s", parsed.Code, parsed.Msg)
	}
	if parsed.SDP == "" {
		return "", fmt.Errorf("zlm webrtc returned empty sdp (raw=%s)", string(body))
	}
	return parsed.SDP, nil
}

// closeStreamsResponse mirrors ZLM /index/api/close_streams JSON response.
type closeStreamsResponse struct {
	Code       int `json:"code"`
	CountHit   int `json:"count_hit"`
	CountClose int `json:"count_closed"`
}

// RecordType identifies the recording container used by ZLM.
type RecordType int

const (
	RecordHLS RecordType = 0 // m3u8 + ts segments
	RecordMP4 RecordType = 1 // single mp4 file
)

// recordResponse mirrors the JSON shape of /startRecord, /stopRecord, /isRecording.
type recordResponse struct {
	Code   int    `json:"code"`
	Msg    string `json:"msg"`
	Result bool   `json:"result"`
}

// StartRecord asks ZLM to begin recording `stream` inside `app`.
func (c *Client) StartRecord(app, stream string, recordType RecordType) error {
	return c.recordCall("/index/api/startRecord", c.recordQuery(app, stream, recordType), "startRecord")
}

// StopRecord asks ZLM to stop recording `stream` inside `app`.
func (c *Client) StopRecord(app, stream string, recordType RecordType) error {
	return c.recordCall("/index/api/stopRecord", c.recordQuery(app, stream, recordType), "stopRecord")
}

// IsRecording queries ZLM for the current recording state.
func (c *Client) IsRecording(app, stream string, recordType RecordType) (bool, error) {
	endpoint := strings.TrimRight(c.cfg.APIBase, "/") + "/index/api/isRecording?" + c.recordQuery(app, stream, recordType).Encode()
	resp, err := c.httpClient.Post(endpoint, "application/json", bytes.NewReader(nil))
	if err != nil {
		return false, fmt.Errorf("call isRecording: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("zlm isRecording http %d: %s", resp.StatusCode, string(body))
	}
	var parsed recordResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return false, fmt.Errorf("decode isRecording response: %w (raw=%s)", err, string(body))
	}
	if parsed.Code != 0 {
		return false, fmt.Errorf("zlm isRecording error code=%d msg=%s", parsed.Code, parsed.Msg)
	}
	return parsed.Result, nil
}

func (c *Client) recordQuery(app, stream string, recordType RecordType) url.Values {
	q := url.Values{}
	q.Set("secret", c.cfg.Secret)
	q.Set("type", fmt.Sprintf("%d", recordType))
	q.Set("vhost", defaultVhost)
	q.Set("app", app)
	q.Set("stream", stream)
	return q
}

func (c *Client) recordCall(path string, q url.Values, label string) error {
	endpoint := strings.TrimRight(c.cfg.APIBase, "/") + path + "?" + q.Encode()
	resp, err := c.httpClient.Post(endpoint, "application/json", bytes.NewReader(nil))
	if err != nil {
		return fmt.Errorf("call %s: %w", label, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("zlm %s http %d: %s", label, resp.StatusCode, string(body))
	}
	var parsed recordResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return fmt.Errorf("decode %s response: %w (raw=%s)", label, err, string(body))
	}
	if parsed.Code != 0 {
		return fmt.Errorf("zlm %s error code=%d msg=%s", label, parsed.Code, parsed.Msg)
	}
	if !parsed.Result {
		return fmt.Errorf("zlm %s returned result=false (msg=%s)", label, parsed.Msg)
	}
	return nil
}

// buildRecordURLPrefix extracts the HTTP-accessible path prefix from ZLM's
// rootPath. ZLM serves its www/ directory at its HTTP root, so a rootPath of
// "/path/to/www/record/live/pub/" maps to URL prefix "/record/live/pub/".
func buildRecordURLPrefix(rootPath string) string {
	idx := strings.Index(rootPath, "www/")
	if idx < 0 {
		return "/"
	}
	prefix := rootPath[idx+4:] // skip "www/"
	// Ensure it ends with /
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	if !strings.HasPrefix(prefix, "/") {
		prefix = "/" + prefix
	}
	return prefix
}

// RecordMp4HookPayload mirrors ZLM on_record_mp4 hook JSON body.
// See: https://docs.zlmediakit.com/guide/media_server/web_hook_api.html
type RecordMp4HookPayload struct {
	MediaServerID string  `json:"mediaServerId"`
	App           string  `json:"app"`
	Stream        string  `json:"stream"`
	Vhost         string  `json:"vhost"`
	FileName      string  `json:"file_name"`
	FilePath      string  `json:"file_path"`
	Folder        string  `json:"folder"`
	FileSize      int64   `json:"file_size"`
	StartTime     int64   `json:"start_time"`
	TimeLen       float64 `json:"time_len"`
	URL           string  `json:"url"` // relative HTTP path under ZLM www/
	HookIndex     int     `json:"hook_index"`
	Params        string  `json:"params"`
}

// BuildRecordURLFromHook turns hook fields into a full playable HTTP URL.
// Priority: url → file_path (www-relative) → folder+file_name via file_path date dir.
func BuildRecordURLFromHook(apiBase string, h *RecordMp4HookPayload) string {
	base := strings.TrimRight(apiBase, "/")

	rel := strings.TrimSpace(h.URL)
	if rel == "" {
		rel = FilePathToHTTP(h.FilePath)
	}
	if rel == "" && h.FileName != "" && h.FilePath != "" {
		// file_path contains the date sub-folder: .../2026-06-21/file_name.mp4
		if idx := strings.LastIndex(h.FilePath, "/"); idx >= 0 {
			parent := h.FilePath[:idx] // .../2026-06-21
			if j := strings.LastIndex(parent, "/"); j >= 0 {
				dateDir := parent[j+1:]
				prefix := buildRecordURLPrefix(h.Folder)
				rel = strings.Trim(prefix, "/") + "/" + dateDir + "/" + h.FileName
			}
		}
	}
	if rel == "" {
		return ""
	}
	return base + "/" + strings.TrimLeft(rel, "/")
}
// ZLM serves everything under its www/ directory at the HTTP root.
//
// Example:
//
//	/home/.../www/record/live/pub/2026-06-21/file.mp4  →  /record/live/pub/2026-06-21/file.mp4
func FilePathToHTTP(abs string) string {
	idx := strings.Index(abs, "www/")
	if idx < 0 {
		idx = strings.Index(abs, "www" + string('/'))
	}
	if idx < 0 {
		return ""
	}
	rel := abs[idx+4:] // skip "www/"
	if !strings.HasPrefix(rel, "/") {
		rel = "/" + rel
	}
	return rel
}

// ErrRecordHookPending is returned when on_record_mp4 hook notification did not
// arrive within the wait window (hook missing or misconfigured).
var ErrRecordHookPending = errors.New("record mp4 hook not received")

// ResolveLatestRecordURL waits for a playable HTTP URL from the on_record_mp4
// hook cache. ZLM must POST to /api/zlm-hook/record-mp4 when a recording
// finishes; no ZLM REST polling is performed.
func (c *Client) ResolveLatestRecordURL(app, stream string) (string, error) {
	const maxAttempts = 10
	const interval = 500 * time.Millisecond

	for i := 0; i < maxAttempts; i++ {
		if u, ok := c.lookupHookRecord(app, stream); ok {
			return u, nil
		}
		if i < maxAttempts-1 {
			time.Sleep(interval)
		}
	}
	return "", fmt.Errorf("%w (app=%s stream=%s)", ErrRecordHookPending, app, stream)
}

// CloseStream forcibly closes a single stream (all schemas) within `app`.
// Used when a user leaves the room or stops sharing their screen.
func (c *Client) CloseStream(app, stream string) error {
	q := url.Values{}
	q.Set("secret", c.cfg.Secret)
	q.Set("vhost", defaultVhost)
	q.Set("app", app)
	q.Set("stream", stream)
	q.Set("force", "1")

	endpoint := strings.TrimRight(c.cfg.APIBase, "/") + "/index/api/close_streams?" + q.Encode()
	resp, err := c.httpClient.Post(endpoint, "application/json", bytes.NewReader(nil))
	if err != nil {
		return fmt.Errorf("call close_streams: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("zlm close_streams http %d: %s", resp.StatusCode, string(body))
	}
	var parsed closeStreamsResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return fmt.Errorf("decode close_streams response: %w (raw=%s)", err, string(body))
	}
	// code==0 includes the case where stream wasn't found; we only log upstream.
	if parsed.Code != 0 {
		return fmt.Errorf("zlm close_streams error code=%d", parsed.Code)
	}
	return nil
}

// MediaInfo is a simplified view of one ZLM media entry.
type MediaInfo struct {
	App              string `json:"app"`
	Stream           string `json:"stream"`
	Schema           string `json:"schema"`
	Vhost            string `json:"vhost"`
	ReaderCount      int    `json:"readerCount"`
	TotalReaderCount int    `json:"totalReaderCount"`
	BytesSpeed       int    `json:"bytesSpeed"`
	AliveSecond      int    `json:"aliveSecond"`
	CreateStamp      int64  `json:"createStamp"`
	OriginType       int    `json:"originType"`
	OriginTypeStr    string `json:"originTypeStr"`
}

type mediaListResponse struct {
	Code int         `json:"code"`
	Msg  string      `json:"msg"`
	Data []MediaInfo `json:"data"`
}

// GetMediaList returns active media streams from ZLM.
func (c *Client) GetMediaList() ([]MediaInfo, error) {
	q := url.Values{}
	q.Set("secret", c.cfg.Secret)
	q.Set("vhost", defaultVhost)

	endpoint := strings.TrimRight(c.cfg.APIBase, "/") + "/index/api/getMediaList?" + q.Encode()
	resp, err := c.httpClient.Get(endpoint)
	if err != nil {
		return nil, fmt.Errorf("call getMediaList: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read getMediaList response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("zlm getMediaList http %d: %s", resp.StatusCode, string(body))
	}
	var parsed mediaListResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("decode getMediaList: %w (raw=%s)", err, string(body))
	}
	if parsed.Code != 0 {
		return nil, fmt.Errorf("zlm getMediaList error code=%d msg=%s", parsed.Code, parsed.Msg)
	}
	return parsed.Data, nil
}
