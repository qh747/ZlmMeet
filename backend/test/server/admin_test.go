package server_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"zlm_meet/backend/pkg/adminauth"
	"zlm_meet/backend/pkg/config"
	"zlm_meet/backend/pkg/server"
	"zlm_meet/backend/pkg/signaling"
	"zlm_meet/backend/pkg/zlm"
)

const adminTokenHeader = "X-Admin-Token"

func newAdminTestServer(t *testing.T) (*httptest.Server, *adminauth.Auth) {
	t.Helper()

	auth := adminauth.New(map[string]string{
		"admin": "secret",
		"ops":   "pass2",
	})
	zlmClient := zlm.New(config.ZLMConfig{
		APIBase: "http://127.0.0.1:1",
		Secret:  "test-secret",
	})
	hub := signaling.NewHub(zlmClient, "")
	cfg := &config.Config{
		AdminStaticDir: "",
		StaticDir:      "",
	}
	handler := server.NewAdmin(cfg, hub, auth)
	return httptest.NewServer(handler), auth
}

func adminLogin(t *testing.T, ts *httptest.Server, username, password string) map[string]any {
	t.Helper()

	body, err := json.Marshal(map[string]string{
		"username": username,
		"password": password,
	})
	if err != nil {
		t.Fatal(err)
	}

	res, err := http.Post(ts.URL+"/api/admin/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()

	var payload map[string]any
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

func adminDashboard(t *testing.T, ts *httptest.Server, token string) (*http.Response, map[string]any) {
	t.Helper()

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/api/admin/dashboard", nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set(adminTokenHeader, token)
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}

	var payload map[string]any
	if res.StatusCode == http.StatusOK {
		if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
			res.Body.Close()
			t.Fatal(err)
		}
	}
	return res, payload
}

func TestAdminLoginSuccessReturnsToken(t *testing.T) {
	ts, _ := newAdminTestServer(t)
	defer ts.Close()

	payload := adminLogin(t, ts, "admin", "secret")
	if payload["ok"] != true {
		t.Fatalf("ok = %v", payload["ok"])
	}
	token, _ := payload["token"].(string)
	if token == "" {
		t.Fatal("expected session token")
	}
}

func TestAdminLoginRejectsBadCredentials(t *testing.T) {
	ts, _ := newAdminTestServer(t)
	defer ts.Close()

	payload := adminLogin(t, ts, "admin", "wrong")
	if payload["ok"] != false {
		t.Fatalf("ok = %v", payload["ok"])
	}
	if payload["message"] != adminauth.ErrInvalidAccount {
		t.Fatalf("message = %v", payload["message"])
	}
}

func TestAdminLoginRejectsEmptyAccountsConfig(t *testing.T) {
	auth := adminauth.New(map[string]string{})
	hub := signaling.NewHub(zlm.New(config.ZLMConfig{}), "")
	handler := server.NewAdmin(&config.Config{}, hub, auth)
	ts := httptest.NewServer(handler)
	defer ts.Close()

	payload := adminLogin(t, ts, "admin", "secret")
	if payload["ok"] != false {
		t.Fatalf("ok = %v", payload["ok"])
	}
	if payload["message"] != adminauth.ErrNotConfigured {
		t.Fatalf("message = %v", payload["message"])
	}
}

func TestAdminLoginMethodNotAllowed(t *testing.T) {
	ts, _ := newAdminTestServer(t)
	defer ts.Close()

	res, err := http.Get(ts.URL + "/api/admin/login")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d", res.StatusCode)
	}
}

func TestAdminDashboardRequiresToken(t *testing.T) {
	ts, _ := newAdminTestServer(t)
	defer ts.Close()

	res, _ := adminDashboard(t, ts, "")
	defer res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d", res.StatusCode)
	}
}

func TestAdminDashboardAcceptsValidToken(t *testing.T) {
	ts, _ := newAdminTestServer(t)
	defer ts.Close()

	login := adminLogin(t, ts, "admin", "secret")
	token, _ := login["token"].(string)

	res, payload := adminDashboard(t, ts, token)
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	if payload["type"] != "dashboard" {
		t.Fatalf("type = %v", payload["type"])
	}
	signaling, ok := payload["signaling"].(map[string]any)
	if !ok {
		t.Fatal("expected signaling object")
	}
	if signaling["status"] != "running" {
		t.Fatalf("signaling status = %v", signaling["status"])
	}
	media, ok := payload["media"].(map[string]any)
	if !ok {
		t.Fatal("expected media object")
	}
	if media["status"] != "offline" {
		t.Fatalf("media status = %v", media["status"])
	}
}

func TestAdminSecondLoginInvalidatesFirstToken(t *testing.T) {
	ts, _ := newAdminTestServer(t)
	defer ts.Close()

	first := adminLogin(t, ts, "admin", "secret")
	token1, _ := first["token"].(string)
	second := adminLogin(t, ts, "admin", "secret")
	token2, _ := second["token"].(string)

	if token1 == token2 {
		t.Fatal("expected different session tokens")
	}

	res, _ := adminDashboard(t, ts, token1)
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("first token status = %d, want 401", res.StatusCode)
	}

	res, payload := adminDashboard(t, ts, token2)
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("second token status = %d", res.StatusCode)
	}
	if payload["type"] != "dashboard" {
		t.Fatalf("type = %v", payload["type"])
	}
}

func TestAdminWSKicksPreviousSessionOnRelogin(t *testing.T) {
	ts, _ := newAdminTestServer(t)
	defer ts.Close()

	first := adminLogin(t, ts, "admin", "secret")
	token1, _ := first["token"].(string)

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/api/admin/ws?token=" + token1
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	second := adminLogin(t, ts, "admin", "secret")
	token2, _ := second["token"].(string)
	if token2 == token1 {
		t.Fatal("expected new token")
	}

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, raw, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read kick message: %v", err)
	}

	var msg map[string]any
	if err := json.Unmarshal(raw, &msg); err != nil {
		t.Fatal(err)
	}
	if msg["type"] != "kick" {
		t.Fatalf("type = %v", msg["type"])
	}
	if msg["message"] != "账号已在其它地方登录" {
		t.Fatalf("message = %v", msg["message"])
	}

	res, _ := adminDashboard(t, ts, token1)
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("old token status = %d", res.StatusCode)
	}
}

func TestAdminDifferentUsersDoNotKickEachOther(t *testing.T) {
	ts, _ := newAdminTestServer(t)
	defer ts.Close()

	admin := adminLogin(t, ts, "admin", "secret")
	ops := adminLogin(t, ts, "ops", "pass2")
	adminToken, _ := admin["token"].(string)
	opsToken, _ := ops["token"].(string)

	res, _ := adminDashboard(t, ts, adminToken)
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admin status = %d", res.StatusCode)
	}

	res, _ = adminDashboard(t, ts, opsToken)
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("ops status = %d", res.StatusCode)
	}
}
