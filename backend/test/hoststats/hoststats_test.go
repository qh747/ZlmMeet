package hoststats_test

import (
	"testing"

	"zlm_meet/backend/pkg/hoststats"
)

func TestSampleReturnsSupportedOnLinux(t *testing.T) {
	s := hoststats.Sample()
	if !s.Supported {
		t.Skip("host stats not supported on this platform")
	}
	if s.MemTotalBytes == 0 {
		t.Fatal("expected mem total on linux")
	}
}
