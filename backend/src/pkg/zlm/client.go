package zlm

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"zlm_meet/backend/pkg/config"
)

// Client wraps the subset of ZLMediaKit's REST API that the signaling server needs.
type Client struct {
	cfg        config.ZLMConfig
	httpClient *http.Client
}

func New(cfg config.ZLMConfig) *Client {
	return &Client{
		cfg:        cfg,
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// App returns the ZLM application name where all meeting streams live.
func (c *Client) App() string { return c.cfg.App }

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
// the answer SDP. `stream` should be unique per (room, user, kind) tuple.
func (c *Client) ExchangeSDP(rtcType WebRTCType, stream, offerSDP string) (string, error) {
	q := url.Values{}
	q.Set("app", c.cfg.App)
	q.Set("stream", stream)
	q.Set("type", string(rtcType))
	if c.cfg.Vhost != "" {
		q.Set("vhost", c.cfg.Vhost)
	}

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
	Code   int  `json:"code"`
	Msg    string `json:"msg"`
	Result bool `json:"result"`
}

// StartRecord asks ZLM to begin recording `stream`. Returns nil on success.
// `recordType` controls the container (MP4 by default).
func (c *Client) StartRecord(stream string, recordType RecordType) error {
	q := url.Values{}
	q.Set("secret", c.cfg.Secret)
	q.Set("type", fmt.Sprintf("%d", recordType))
	q.Set("vhost", c.cfg.Vhost)
	q.Set("app", c.cfg.App)
	q.Set("stream", stream)
	return c.recordCall("/index/api/startRecord", q, "startRecord")
}

// StopRecord asks ZLM to stop recording `stream`. Returns nil on success.
func (c *Client) StopRecord(stream string, recordType RecordType) error {
	q := url.Values{}
	q.Set("secret", c.cfg.Secret)
	q.Set("type", fmt.Sprintf("%d", recordType))
	q.Set("vhost", c.cfg.Vhost)
	q.Set("app", c.cfg.App)
	q.Set("stream", stream)
	return c.recordCall("/index/api/stopRecord", q, "stopRecord")
}

// IsRecording queries ZLM for the current recording state of `stream`.
func (c *Client) IsRecording(stream string, recordType RecordType) (bool, error) {
	q := url.Values{}
	q.Set("secret", c.cfg.Secret)
	q.Set("type", fmt.Sprintf("%d", recordType))
	q.Set("vhost", c.cfg.Vhost)
	q.Set("app", c.cfg.App)
	q.Set("stream", stream)

	endpoint := strings.TrimRight(c.cfg.APIBase, "/") + "/index/api/isRecording?" + q.Encode()
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

// CloseStream forcibly closes a single stream (all schemas). Used when a user
// leaves the room or stops sharing their screen.
func (c *Client) CloseStream(stream string) error {
	q := url.Values{}
	q.Set("secret", c.cfg.Secret)
	q.Set("vhost", c.cfg.Vhost)
	q.Set("app", c.cfg.App)
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
