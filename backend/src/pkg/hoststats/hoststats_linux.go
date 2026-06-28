//go:build linux

package hoststats

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	startTime = time.Now()
	prevCPU   cpuSample
	cpuMu     sync.Mutex
	prevProc  procCPUSample
	procCPUMu sync.Mutex
)

type procCPUSample struct {
	ticks uint64
	at    time.Time
}

const clockTicksPerSec = 100

type cpuSample struct {
	total uint64
	idle  uint64
	at    time.Time
}

// Sample reads current host and process stats from /proc.
func Sample() Snapshot {
	memTotal, memAvail := readMemInfo()
	memUsed := memTotal
	if memAvail <= memTotal {
		memUsed = memTotal - memAvail
	}

	cpuPct := sampleHostCPU()
	procCPU := sampleProcessCPU()
	rss := readProcessRSS()
	goroutines, heap := readRuntimeStats()

	return Snapshot{
		CPUUsagePercent:        cpuPct,
		MemUsedBytes:           memUsed,
		MemTotalBytes:          memTotal,
		MemUsagePercent:        percent(memUsed, memTotal),
		ProcessCPUUsagePercent: procCPU,
		ProcessRSSBytes:        rss,
		GoHeapBytes:            heap,
		GoroutineCount:         goroutines,
		OpenFDCount:            readOpenFDCount(),
		UptimeSeconds:          uint64(time.Since(startTime).Seconds()),
		Supported:              true,
	}
}

func sampleHostCPU() float64 {
	cur, ok := readHostCPU()
	if !ok {
		return 0
	}

	cpuMu.Lock()
	defer cpuMu.Unlock()

	if prevCPU.at.IsZero() {
		prevCPU = cur
		return 0
	}

	elapsed := cur.at.Sub(prevCPU.at).Seconds()
	if elapsed <= 0 {
		return 0
	}

	totalDelta := float64(cur.total - prevCPU.total)
	idleDelta := float64(cur.idle - prevCPU.idle)
	prevCPU = cur

	if totalDelta <= 0 {
		return 0
	}
	usage := (1 - idleDelta/totalDelta) * 100
	if usage < 0 {
		return 0
	}
	if usage > 100 {
		return 100
	}
	return usage
}

func sampleProcessCPU() float64 {
	ticks, ok := readProcessCPUTicks()
	if !ok {
		return 0
	}

	cur := procCPUSample{ticks: ticks, at: time.Now()}
	procCPUMu.Lock()
	defer procCPUMu.Unlock()

	if prevProc.at.IsZero() {
		prevProc = cur
		return 0
	}

	elapsed := cur.at.Sub(prevProc.at).Seconds()
	if elapsed <= 0 {
		return 0
	}

	tickDelta := float64(cur.ticks - prevProc.ticks)
	prevProc = cur
	if tickDelta <= 0 {
		return 0
	}

	cpuSeconds := tickDelta / clockTicksPerSec
	usage := cpuSeconds / elapsed * 100
	if usage < 0 {
		return 0
	}
	return usage
}

func readProcessCPUTicks() (uint64, bool) {
	data, err := os.ReadFile("/proc/self/stat")
	if err != nil {
		return 0, false
	}

	s := string(data)
	end := strings.LastIndex(s, ")")
	if end < 0 || end+2 >= len(s) {
		return 0, false
	}

	fields := strings.Fields(s[end+2:])
	if len(fields) < 13 {
		return 0, false
	}

	utime, err := strconv.ParseUint(fields[11], 10, 64)
	if err != nil {
		return 0, false
	}
	stime, err := strconv.ParseUint(fields[12], 10, 64)
	if err != nil {
		return 0, false
	}
	return utime + stime, true
}

func readOpenFDCount() int {
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return 0
	}
	return len(entries)
}

func readHostCPU() (cpuSample, bool) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return cpuSample{}, false
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	if !sc.Scan() {
		return cpuSample{}, false
	}
	fields := strings.Fields(sc.Text())
	if len(fields) < 5 || fields[0] != "cpu" {
		return cpuSample{}, false
	}

	var vals []uint64
	for _, field := range fields[1:] {
		n, err := strconv.ParseUint(field, 10, 64)
		if err != nil {
			return cpuSample{}, false
		}
		vals = append(vals, n)
	}

	var total, idle uint64
	for _, v := range vals {
		total += v
	}
	if len(vals) > 3 {
		idle = vals[3]
	}
	return cpuSample{total: total, idle: idle, at: time.Now()}, true
}

func readMemInfo() (total, avail uint64) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "MemTotal:"):
			total = parseMeminfoKB(line)
		case strings.HasPrefix(line, "MemAvailable:"):
			avail = parseMeminfoKB(line)
		}
	}
	return total * 1024, avail * 1024
}

func parseMeminfoKB(line string) uint64 {
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return 0
	}
	n, _ := strconv.ParseUint(fields[1], 10, 64)
	return n
}

func readProcessRSS() uint64 {
	f, err := os.Open("/proc/self/status")
	if err != nil {
		return 0
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "VmRSS:") {
			fields := strings.Fields(line)
			if len(fields) < 2 {
				return 0
			}
			kb, _ := strconv.ParseUint(fields[1], 10, 64)
			return kb * 1024
		}
	}
	return 0
}

func percent(used, total uint64) float64 {
	if total == 0 {
		return 0
	}
	p := float64(used) / float64(total) * 100
	if p > 100 {
		return 100
	}
	return p
}
