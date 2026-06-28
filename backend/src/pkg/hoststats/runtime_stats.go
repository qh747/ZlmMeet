package hoststats

import "runtime"

func readRuntimeStats() (goroutines int, heapBytes uint64) {
	goroutines = runtime.NumGoroutine()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return goroutines, ms.Alloc
}
