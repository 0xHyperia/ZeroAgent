package account

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

// This opt-in workload uses the production PostgreSQL scheduler and Go model
// loop, but a bounded local HTTP model. It measures neither a remote model SLA
// nor E2B performance. Its schema and Redis keys are owned by existing isolated
// integration fixtures, and its report never contains their connection strings.
func TestCloudCapacityPostgresBaseline(t *testing.T) {
	reportDir := os.Getenv("ZEROAGENT_CLOUD_CAPACITY_REPORT_DIR")
	if reportDir == "" {
		t.Skip("explicit local capacity report directory is required")
	}
	for _, workers := range []int{2, 4} {
		t.Run(fmt.Sprintf("workers_%d", workers), func(t *testing.T) {
			runCloudCapacityBaseline(t, workers, reportDir)
		})
	}
}

type cloudCapacitySample struct {
	Account           int64   `json:"account"`
	Ordinal           int     `json:"ordinal"`
	OutputBytes       int     `json:"output_bytes"`
	QueueMilliseconds float64 `json:"queue_ms"`
	FirstMilliseconds float64 `json:"first_persisted_delta_ms"`
	TotalMilliseconds float64 `json:"total_ms"`
}

type cloudCapacityReport struct {
	Version                int                   `json:"version"`
	Kind                   string                `json:"kind"`
	OutputPattern          string                `json:"output_pattern"`
	PercentileMethod       string                `json:"percentile_method"`
	Workers                int                   `json:"workers"`
	Accounts               int                   `json:"accounts"`
	TasksPerAccount        int                   `json:"tasks_per_account"`
	MaxExecutingPerAccount int                   `json:"max_executing_per_account"`
	ModelFirstDelayMS      int                   `json:"model_first_delay_ms"`
	ModelChunkDelayMS      int                   `json:"model_chunk_delay_ms"`
	ModelChunks            int                   `json:"model_chunks"`
	WallMilliseconds       float64               `json:"wall_ms"`
	ThroughputPerSecond    float64               `json:"completed_per_second"`
	QueueP50MS             float64               `json:"queue_p50_ms"`
	QueueP95MS             float64               `json:"queue_p95_ms"`
	FirstP50MS             float64               `json:"first_persisted_delta_p50_ms"`
	FirstP95MS             float64               `json:"first_persisted_delta_p95_ms"`
	TotalP50MS             float64               `json:"total_p50_ms"`
	TotalP95MS             float64               `json:"total_p95_ms"`
	ModelCalls             int                   `json:"model_calls"`
	MaxModelParallel       int                   `json:"max_model_parallel"`
	MaxAccountModel        int                   `json:"max_account_model_parallel"`
	MaxAccountRunning      int                   `json:"max_account_running_sampled"`
	FirstRoundAccounts     []int64               `json:"first_round_accounts"`
	FairFirstRound         bool                  `json:"fair_first_round"`
	Runs                   int                   `json:"runs"`
	CanonicalMessages      int                   `json:"canonical_messages"`
	Events                 int                   `json:"events"`
	OutputBytes            int64                 `json:"output_bytes"`
	EventPayloadBytes      int64                 `json:"event_payload_bytes"`
	CanonicalContentBytes  int64                 `json:"canonical_content_bytes"`
	RelationBytesBefore    int64                 `json:"relation_bytes_before"`
	RelationBytesAfter     int64                 `json:"relation_bytes_after"`
	RelationBytesGrowth    int64                 `json:"relation_bytes_growth"`
	HeapBeforeBytes        uint64                `json:"process_heap_before_bytes"`
	HeapPeakBytes          uint64                `json:"process_heap_peak_sampled_bytes"`
	HeapAfterBytes         uint64                `json:"process_heap_after_bytes"`
	GCCount                uint32                `json:"process_gc_count"`
	GOMAXPROCS             int                   `json:"gomaxprocs"`
	NumCPU                 int                   `json:"num_cpu"`
	DBMaxOpenConnections   int                   `json:"db_max_open_connections"`
	GoVersion              string                `json:"go_version"`
	OS                     string                `json:"os"`
	Arch                   string                `json:"arch"`
	Samples                []cloudCapacitySample `json:"samples"`
}

func cloudCapacityPercentile(values []float64, percentile float64) float64 {
	ordered := append([]float64(nil), values...)
	sort.Float64s(ordered)
	index := max(0, int(math.Ceil(float64(len(ordered))*percentile))-1)
	return ordered[index]
}

func runCloudCapacityBaseline(t *testing.T, workers int, reportDir string) {
	t.Helper()
	const accounts, perAccount, firstDelay, chunkDelay, chunks = 10, 3, 120, 25, 4
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	f := cloudRunPostgresFixture(t)
	authority := redisSessionRefreshFixture(t)
	store := f.store.(*PersistentStore)
	store.rdb = authority.store.(*PersistentStore).rdb
	if _, err := store.db.ExecContext(ctx, CloudFileSchema+CloudProjectSchema+CloudMemorySchema+CloudToolSchema+CloudResearchSourceSchema); err != nil {
		t.Fatal(err)
	}
	if err := store.ConfigureCloudRunAdmission(ctx, CloudRunAdmissionLimits{MaxExecutingPerAccount: 1, MaxQueuedPerAccount: 20}); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	activeAccounts := map[int64]int{}
	calls := map[string]int{}
	startOrder := []int64{}
	active, maxActive, maxAccount := 0, 0, 0
	platform := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/keys":
			_, _ = io.WriteString(w, `{"code":0,"data":{"items":[{"id":41,"key":"capacity-fixture-model-key","status":"active"}]}}`)
		case "/v1/chat/completions":
			var request struct {
				Messages []struct {
					Role    string          `json:"role"`
					Content json.RawMessage `json:"content"`
				} `json:"messages"`
			}
			if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&request) != nil {
				t.Error("invalid local model request")
				w.WriteHeader(400)
				return
			}
			var marker string
			for _, message := range request.Messages {
				if message.Role == "user" {
					_ = json.Unmarshal(message.Content, &marker)
				}
			}
			var uid int64
			var ordinal int
			if _, err := fmt.Sscanf(marker, "capacity-account-%d-task-%d", &uid, &ordinal); err != nil || uid < 101 || uid > 110 || ordinal < 0 || ordinal >= perAccount {
				t.Error("model lost canonical current user message")
				w.WriteHeader(400)
				return
			}
			mu.Lock()
			calls[marker]++
			active++
			activeAccounts[uid]++
			maxActive = max(maxActive, active)
			maxAccount = max(maxAccount, activeAccounts[uid])
			startOrder = append(startOrder, uid)
			mu.Unlock()
			defer func() {
				mu.Lock()
				active--
				activeAccounts[uid]--
				mu.Unlock()
			}()
			select {
			case <-time.After(firstDelay * time.Millisecond):
			case <-r.Context().Done():
				return
			}
			size := []int{16 << 10, 64 << 10, 128 << 10}[ordinal]
			text := cloudCapacityOutput(uid, ordinal, size)
			for index := range chunks {
				emitCloudDelta(w, text[index*size/chunks:(index+1)*size/chunks])
				select {
				case <-time.After(chunkDelay * time.Millisecond):
				case <-r.Context().Done():
					return
				}
			}
			emitModelFinish(w, "stop", 1)
		default:
			t.Errorf("unexpected local platform path %s", r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	t.Cleanup(platform.Close)
	service := NewService(store, NewUSAClientWithHTTPClient(platform.URL, platform.Client()), time.Hour, time.Hour)
	t.Cleanup(service.CloseCloudRuns)
	config := DefaultCloudRuntimeConfig()
	config.WorkerCount = workers
	if err := service.SetCloudRuntimeConfig(config); err != nil {
		t.Fatal(err)
	}
	type task struct {
		run     *CloudRun
		ordinal int
	}
	tasks := make([]task, 0, accounts*perAccount)
	for uid := int64(101); uid < 101+accounts; uid++ {
		session := &Session{ID: "capacity-fixture-" + uuid.NewString(), UserID: uid, AccessToken: "capacity-fixture-access", RefreshToken: "capacity-fixture-refresh", AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)}
		authority.remember(session.ID)
		if err := store.PutSession(ctx, session); err != nil {
			t.Fatal(err)
		}
		ref, err := store.BindCloudRunSession(ctx, session)
		if err != nil {
			t.Fatal(err)
		}
		for ordinal := range perAccount {
			input := cloudRunTestInput(t, f, uid, "", uuid.NewString(), fmt.Sprintf("capacity-account-%d-task-%d", uid, ordinal))
			input.SessionRef, input.ProviderKeyID = ref, 41
			run, created, err := store.CreateCloudRun(ctx, input)
			if err != nil || !created {
				t.Fatalf("enqueue baseline: created=%v err=%v", created, err)
			}
			tasks = append(tasks, task{run, ordinal})
		}
	}
	relationBytes := func() int64 {
		var total int64
		if err := store.db.QueryRowContext(ctx, `SELECT COALESCE(sum(pg_total_relation_size(c.oid)),0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r'`).Scan(&total); err != nil {
			t.Fatal(err)
		}
		return total
	}
	report := cloudCapacityReport{Version: 1, Kind: "local_postgres_redis_fixed_http_model", OutputPattern: "deterministic per-account/task SHA256 hex lines, not repeated padding", PercentileMethod: "nearest_rank", Workers: workers, Accounts: accounts, TasksPerAccount: perAccount, MaxExecutingPerAccount: 1, ModelFirstDelayMS: firstDelay, ModelChunkDelayMS: chunkDelay, ModelChunks: chunks, RelationBytesBefore: relationBytes(), GOMAXPROCS: runtime.GOMAXPROCS(0), NumCPU: runtime.NumCPU(), DBMaxOpenConnections: store.db.Stats().MaxOpenConnections, GoVersion: runtime.Version(), OS: runtime.GOOS, Arch: runtime.GOARCH}
	var memoryBefore, memoryAfter runtime.MemStats
	runtime.ReadMemStats(&memoryBefore)
	report.HeapBeforeBytes, report.HeapPeakBytes = memoryBefore.HeapAlloc, memoryBefore.HeapAlloc
	started := time.Now()
	if err := service.StartCloudRuns(ctx); err != nil {
		t.Fatal(err)
	}
	for {
		var terminal, runningPerAccount int
		if err := store.db.QueryRowContext(ctx, `SELECT count(*) FILTER (WHERE state IN ('completed','failed','cancelled','interrupted')) FROM zeroagent_cloud_runs`).Scan(&terminal); err != nil {
			t.Fatal(err)
		}
		if err := store.db.QueryRowContext(ctx, `SELECT COALESCE(max(n),0) FROM (SELECT count(*) AS n FROM zeroagent_cloud_runs WHERE state IN ('running','cancelling') GROUP BY user_id) a`).Scan(&runningPerAccount); err != nil {
			t.Fatal(err)
		}
		report.MaxAccountRunning = max(report.MaxAccountRunning, runningPerAccount)
		var memory runtime.MemStats
		runtime.ReadMemStats(&memory)
		report.HeapPeakBytes = max(report.HeapPeakBytes, memory.HeapAlloc)
		if terminal == len(tasks) {
			break
		}
		select {
		case <-time.After(20 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal("finite local capacity workload exceeded deadline")
		}
	}
	report.WallMilliseconds = float64(time.Since(started)) / float64(time.Millisecond)
	report.ThroughputPerSecond = float64(len(tasks)) / (report.WallMilliseconds / 1000)
	service.CloseCloudRuns()
	runtime.ReadMemStats(&memoryAfter)
	report.HeapAfterBytes, report.GCCount = memoryAfter.HeapAlloc, memoryAfter.NumGC-memoryBefore.NumGC
	queue, first, total := []float64{}, []float64{}, []float64{}
	for _, task := range tasks {
		run, err := store.GetCloudRun(ctx, task.run.UserID, task.run.ID)
		if err != nil {
			t.Fatalf("lost task: %v", err)
		}
		if run.State != CloudRunCompleted {
			t.Fatalf("failed task: state=%s code=%s", run.State, run.ErrorCode)
		}
		size := []int{16 << 10, 64 << 10, 128 << 10}[task.ordinal]
		if run.Output != cloudCapacityOutput(run.UserID, task.ordinal, size) {
			t.Fatal("output lost, duplicated or assigned to another task")
		}
		var startAt, firstAt time.Time
		if err := store.db.QueryRowContext(ctx, `SELECT min(created_at) FILTER (WHERE type='run.started'),min(created_at) FILTER (WHERE type='message.delta') FROM zeroagent_cloud_run_events WHERE run_id=$1`, run.ID).Scan(&startAt, &firstAt); err != nil {
			t.Fatal(err)
		}
		sample := cloudCapacitySample{Account: run.UserID, Ordinal: task.ordinal, OutputBytes: len(run.Output), QueueMilliseconds: float64(startAt.Sub(run.CreatedAt)) / float64(time.Millisecond), FirstMilliseconds: float64(firstAt.Sub(run.CreatedAt)) / float64(time.Millisecond), TotalMilliseconds: float64(run.UpdatedAt.Sub(run.CreatedAt)) / float64(time.Millisecond)}
		report.Samples = append(report.Samples, sample)
		queue, first, total = append(queue, sample.QueueMilliseconds), append(first, sample.FirstMilliseconds), append(total, sample.TotalMilliseconds)
		messages, err := store.ListCloudMessages(ctx, run.UserID, run.ConversationID)
		if err != nil || len(messages) != 2 || messages[0].Role != "user" || messages[1].Role != "assistant" || messages[1].ID != run.AssistantMessageID {
			t.Fatal("canonical task history lost or duplicated")
		}
	}
	mu.Lock()
	report.ModelCalls, report.MaxModelParallel, report.MaxAccountModel = len(calls), maxActive, maxAccount
	report.FirstRoundAccounts = append([]int64(nil), startOrder[:min(accounts, len(startOrder))]...)
	for _, count := range calls {
		if count != 1 {
			t.Errorf("same accepted task invoked local model %d times", count)
		}
	}
	mu.Unlock()
	seen := map[int64]bool{}
	for _, uid := range report.FirstRoundAccounts {
		seen[uid] = true
	}
	report.FairFirstRound = len(seen) == accounts
	if !report.FairFirstRound || report.ModelCalls != accounts*perAccount || report.MaxAccountModel > 1 || report.MaxAccountRunning > 1 || report.MaxModelParallel > workers {
		t.Errorf("scheduler capacity invariant failed: fair=%v calls=%d modelPerAccount=%d durablePerAccount=%d global=%d", report.FairFirstRound, report.ModelCalls, report.MaxAccountModel, report.MaxAccountRunning, report.MaxModelParallel)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT count(*),COALESCE(sum(octet_length(output)),0) FROM zeroagent_cloud_runs`).Scan(&report.Runs, &report.OutputBytes); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT count(*),COALESCE(sum(octet_length(payload::text)),0) FROM zeroagent_cloud_run_events`).Scan(&report.Events, &report.EventPayloadBytes); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT count(*),COALESCE(sum(octet_length(content::text)),0) FROM zerobox_cloud_messages`).Scan(&report.CanonicalMessages, &report.CanonicalContentBytes); err != nil {
		t.Fatal(err)
	}
	report.RelationBytesAfter = relationBytes()
	report.RelationBytesGrowth = report.RelationBytesAfter - report.RelationBytesBefore
	report.QueueP50MS, report.QueueP95MS = cloudCapacityPercentile(queue, .5), cloudCapacityPercentile(queue, .95)
	report.FirstP50MS, report.FirstP95MS = cloudCapacityPercentile(first, .5), cloudCapacityPercentile(first, .95)
	report.TotalP50MS, report.TotalP95MS = cloudCapacityPercentile(total, .5), cloudCapacityPercentile(total, .95)
	if err := os.MkdirAll(reportDir, 0700); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(reportDir, fmt.Sprintf("capacity-workers-%d.json", workers)), append(encoded, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("local fixed model: workers=%d tasks=%d queue p50/p95=%.1f/%.1fms persisted-first p50/p95=%.1f/%.1fms wall=%.1fms output=%dB DBgrowth=%dB", workers, len(tasks), report.QueueP50MS, report.QueueP95MS, report.FirstP50MS, report.FirstP95MS, report.WallMilliseconds, report.OutputBytes, report.RelationBytesGrowth)
}

func cloudCapacityOutput(uid int64, ordinal, size int) string {
	var output strings.Builder
	output.Grow(size + 65)
	_, _ = fmt.Fprintf(&output, "capacity-output-account-%d-task-%d\n", uid, ordinal)
	for index := 0; output.Len() < size; index++ {
		digest := sha256.Sum256([]byte(fmt.Sprintf("%d/%d/%d", uid, ordinal, index)))
		output.WriteString(hex.EncodeToString(digest[:]))
		output.WriteByte('\n')
	}
	return output.String()[:size]
}
