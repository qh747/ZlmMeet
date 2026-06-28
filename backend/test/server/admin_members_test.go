package server_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAdminMembersAPI(t *testing.T) {
	ts, _ := newAdminTestServer(t)
	defer ts.Close()

	login := adminLogin(t, ts, "admin", "secret")
	token, _ := login["token"].(string)

	res, payload := adminGET(t, ts, "/api/admin/members", token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	members, ok := payload["members"].([]any)
	if !ok {
		t.Fatalf("expected members array, got %T", payload["members"])
	}
	if members == nil {
		t.Fatal("members should not be nil")
	}
}

func TestAdminKickAndDissolveAPI(t *testing.T) {
	ts, _ := newAdminTestServer(t)
	defer ts.Close()

	login := adminLogin(t, ts, "admin", "secret")
	token, _ := login["token"].(string)

	body, _ := json.Marshal(map[string]string{"room": "missing", "userId": "u1"})
	res, payload := adminPOST(t, ts, "/api/admin/rooms/kick", token, body)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("kick status %d", res.StatusCode)
	}
	if payload["ok"] != false {
		t.Fatalf("expected ok=false")
	}

	body, _ = json.Marshal(map[string]string{"room": "missing"})
	res, payload = adminPOST(t, ts, "/api/admin/rooms/dissolve", token, body)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("dissolve status %d", res.StatusCode)
	}
	if payload["ok"] != false {
		t.Fatalf("expected ok=false")
	}
}

func adminGET(t *testing.T, ts *httptest.Server, path, token string) (*http.Response, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, ts.URL+path, nil)
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
	defer res.Body.Close()
	var payload map[string]any
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	return res, payload
}

func adminPOST(t *testing.T, ts *httptest.Server, path, token string, body []byte) (*http.Response, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, ts.URL+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set(adminTokenHeader, token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var payload map[string]any
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	return res, payload
}
