//go:build !linux

package hoststats

import "time"

var startTime = time.Now()

// Sample returns runtime stats on non-Linux platforms.
func Sample() Snapshot {
	goroutines, heap := readRuntimeStats()
	return Snapshot{
		GoHeapBytes:    heap,
		GoroutineCount: goroutines,
		UptimeSeconds:  uint64(time.Since(startTime).Seconds()),
		Supported:      false,
	}
}
