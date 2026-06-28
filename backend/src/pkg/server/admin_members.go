package server

import "zlm_meet/backend/pkg/signaling"

func buildMemberSnapshot(hub *signaling.Hub) ([]signaling.MemberRow, string) {
	return hub.MemberSnapshot()
}
