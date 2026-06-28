package signaling_test

import (
	"testing"

	"zlm_meet/backend/pkg/signaling"
)

func TestObserverDoesNotFillCallCapacity(t *testing.T) {
	h := signaling.NewHub(nil, "")
	c1 := signaling.NewTestClient("u1", "Alice", nil)
	c2 := signaling.NewTestClient("u2", "Bob", nil)
	if err := h.AddTestClient("call1", signaling.RoomModeCall, c1); err != nil {
		t.Fatal(err)
	}
	if err := h.AddTestClient("call1", signaling.RoomModeCall, c2); err != nil {
		t.Fatal(err)
	}

	obs := signaling.NewTestClient("obs1", "admin", nil)
	obs.SetObserver("tok", "admin", nil)
	if err := h.AddTestObserverClient("call1", obs); err != nil {
		t.Fatal(err)
	}

	c3 := signaling.NewTestClient("u3", "Charlie", nil)
	if err := h.AddTestClient("call1", signaling.RoomModeCall, c3); err == nil {
		t.Fatal("expected room full with two real members")
	}
}

func TestObserverExcludedFromStatsRealMembers(t *testing.T) {
	h := signaling.NewHub(nil, "")
	c1 := signaling.NewTestClient("u1", "Alice", nil)
	if err := h.AddTestClient("m1", signaling.RoomModeMeeting, c1); err != nil {
		t.Fatal(err)
	}
	obs := signaling.NewTestClient("obs1", "admin", nil)
	obs.SetObserver("tok", "admin", nil)
	if err := h.AddTestObserverClient("m1", obs); err != nil {
		t.Fatal(err)
	}

	stats := h.StatsSnapshot()
	if len(stats.Rooms) != 1 {
		t.Fatalf("rooms=%d", len(stats.Rooms))
	}
	rs := stats.Rooms[0]
	if rs.RealMembers != 1 || rs.Observers != 1 || rs.Members != 2 {
		t.Fatalf("real=%d obs=%d members=%d", rs.RealMembers, rs.Observers, rs.Members)
	}
}

func TestObserverDismissedWhenBusinessEnds(t *testing.T) {
	h := signaling.NewHub(nil, "")
	c1 := signaling.NewTestClient("u1", "Alice", nil)
	if err := h.AddTestClient("m1", signaling.RoomModeMeeting, c1); err != nil {
		t.Fatal(err)
	}

	obs := signaling.NewTestClient("obs1", "admin", nil)
	obs.SetObserver("tok", "admin", nil)
	if err := h.AddTestObserverClient("m1", obs); err != nil {
		t.Fatal(err)
	}

	c1.LeaveRoom()
	stats := h.StatsSnapshot()
	if len(stats.Rooms) != 0 {
		t.Fatalf("rooms=%d want 0 after business ended", len(stats.Rooms))
	}
}
