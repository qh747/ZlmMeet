package hoststats

// Snapshot holds host and process resource usage for the admin dashboard.
type Snapshot struct {
	CPUUsagePercent        float64 `json:"cpuUsagePercent"`
	MemUsedBytes           uint64  `json:"memUsedBytes"`
	MemTotalBytes          uint64  `json:"memTotalBytes"`
	MemUsagePercent        float64 `json:"memUsagePercent"`
	ProcessCPUUsagePercent float64 `json:"processCpuUsagePercent"`
	ProcessRSSBytes        uint64  `json:"processRssBytes"`
	GoHeapBytes            uint64  `json:"goHeapBytes"`
	GoroutineCount         int     `json:"goroutineCount"`
	OpenFDCount            int     `json:"openFdCount"`
	UptimeSeconds          uint64  `json:"uptimeSeconds"`
	Supported              bool    `json:"supported"`
}
