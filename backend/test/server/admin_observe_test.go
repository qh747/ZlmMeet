package server_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"zlm_meet/backend/pkg/adminauth"
)

func TestAdminLogoutInvalidatesToken(t *testing.T) {
	auth := adminauth.New(map[string]string{"admin": "secret"})
	tok, err := auth.Login("admin", "secret")
	if err != nil {
		t.Fatal(err)
	}
	if err := auth.Logout(tok); err != nil {
		t.Fatal(err)
	}
	if _, err := auth.ValidateToken(tok); err == nil {
		t.Fatal("token should be invalid after logout")
	}
}

func TestAdminLogoutAPI(t *testing.T) {
	ts, _ := newAdminTestServer(t)
	defer ts.Close()

	login := adminLogin(t, ts, "admin", "secret")
	token, _ := login["token"].(string)

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/admin/logout", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(adminTokenHeader, token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()

	var body map[string]any
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["ok"] != true {
		t.Fatalf("logout response: %v", body)
	}

	req2, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/admin/dashboard", nil)
	req2.Header.Set(adminTokenHeader, token)
	res2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer res2.Body.Close()
	if res2.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status=%d want 401", res2.StatusCode)
	}
}

func TestAdminAuditLogAPI(t *testing.T) {
	ts, _ := newAdminTestServer(t)
	defer ts.Close()

	login := adminLogin(t, ts, "admin", "secret")
	token, _ := login["token"].(string)

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/api/admin/audit-log", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(adminTokenHeader, token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status=%d", res.StatusCode)
	}

	delReq, err := http.NewRequest(http.MethodDelete, ts.URL+"/api/admin/audit-log", nil)
	if err != nil {
		t.Fatal(err)
	}
	delReq.Header.Set(adminTokenHeader, token)
	delRes, err := http.DefaultClient.Do(delReq)
	if err != nil {
		t.Fatal(err)
	}
	defer delRes.Body.Close()
	if delRes.StatusCode != http.StatusOK {
		t.Fatalf("delete status=%d", delRes.StatusCode)
	}
}
