package server

import (
	"sync"
	"time"

	"github.com/rs/zerolog/log"
)

// AuditEntry is one admin audit log record.
type AuditEntry struct {
	Time     int64  `json:"time"`
	Username string `json:"username"`
	Action   string `json:"action"`
	Room     string `json:"room,omitempty"`
	Detail   string `json:"detail,omitempty"`
}

// AuditLog keeps a bounded in-memory audit trail for the admin API.
type AuditLog struct {
	mu       sync.Mutex
	entries  []AuditEntry
	max      int
	onChange func()
}

func NewAuditLog(max int) *AuditLog {
	if max <= 0 {
		max = 200
	}
	return &AuditLog{max: max}
}

// SetChangeHook is invoked after each new audit entry is recorded.
func (l *AuditLog) SetChangeHook(fn func()) {
	l.mu.Lock()
	l.onChange = fn
	l.mu.Unlock()
}

func (l *AuditLog) Record(username, action, room, detail string) {
	entry := AuditEntry{
		Time:     time.Now().UnixMilli(),
		Username: username,
		Action:   action,
		Room:     room,
		Detail:   detail,
	}
	l.mu.Lock()
	l.entries = append(l.entries, entry)
	if len(l.entries) > l.max {
		l.entries = l.entries[len(l.entries)-l.max:]
	}
	onChange := l.onChange
	l.mu.Unlock()

	log.Info().
		Str("admin_user", username).
		Str("action", action).
		Str("room", room).
		Str("detail", detail).
		Msg("admin audit")

	if onChange != nil {
		onChange()
	}
}

func (l *AuditLog) Recent(limit int) []AuditEntry {
	if limit <= 0 {
		limit = 50
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.entries) == 0 {
		return []AuditEntry{}
	}
	start := 0
	if len(l.entries) > limit {
		start = len(l.entries) - limit
	}
	out := make([]AuditEntry, len(l.entries)-start)
	copy(out, l.entries[start:])
	return out
}

// Clear removes all audit entries and notifies subscribers.
func (l *AuditLog) Clear() {
	l.mu.Lock()
	l.entries = []AuditEntry{}
	onChange := l.onChange
	l.mu.Unlock()
	if onChange != nil {
		onChange()
	}
}
