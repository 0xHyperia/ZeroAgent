package account

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func runCloudAllocationContract(t *testing.T, store CloudAllocationStore) {
	t.Helper()
	ctx := context.Background()
	op := uuid.NewString()
	first, created, err := store.ReserveCloudAllocation(ctx, 71, op, "file_parser", 300, 600)
	if err != nil || !created || first.Seconds != 300 {
		t.Fatalf("reservation=%+v %v", first, err)
	}
	var group sync.WaitGroup
	for i := 0; i < 16; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			again, created, err := store.ReserveCloudAllocation(ctx, 71, op, "file_parser", 300, 600)
			if err != nil || created || again.Day != first.Day {
				t.Errorf("duplicate budget charged: %+v %v", again, err)
			}
		}()
	}
	group.Wait()
	if _, created, err = store.ReserveCloudAllocation(ctx, 71, uuid.NewString(), "conversation", 300, 600); err != nil || !created {
		t.Fatal("shared conversation allowance missing")
	}
	if _, _, err = store.ReserveCloudAllocation(ctx, 71, uuid.NewString(), "file_parser", 1, 600); !errors.Is(err, ErrCloudToolQuota) {
		t.Fatalf("parser bypassed shared quota: %v", err)
	}
	if _, _, err = store.ReserveCloudAllocation(ctx, 71, op, "conversation", 300, 600); !errors.Is(err, ErrCloudToolConflict) {
		t.Fatal("purpose changed")
	}
	if _, _, err = store.ReserveCloudAllocation(ctx, 72, op, "file_parser", 300, 600); !errors.Is(err, ErrCloudToolConflict) {
		t.Fatal("foreign operation reservation accepted")
	}
	var wins atomic.Int32
	for i := 0; i < 12; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			_, created, err := store.ReserveCloudAllocation(ctx, 73, uuid.NewString(), "file_parser", 300, 900)
			if err == nil && created {
				wins.Add(1)
			} else if !errors.Is(err, ErrCloudToolQuota) {
				t.Errorf("quota race: %v", err)
			}
		}()
	}
	group.Wait()
	if wins.Load() != 3 {
		t.Fatalf("quota race reserved %d", wins.Load())
	}
}
func TestCloudAllocationMemoryContract(t *testing.T) {
	store := NewMemoryStore()
	runCloudAllocationContract(t, store)
	ctx := context.Background()
	var now = time.Now()
	store.now = func() time.Time { return now }
	op := uuid.NewString()
	first, _, err := store.ReserveCloudAllocation(ctx, 74, op, "file_parser", 300, 300)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(24 * time.Hour)
	again, created, err := store.ReserveCloudAllocation(ctx, 74, op, "file_parser", 300, 300)
	if err != nil || created || again.Day != first.Day {
		t.Fatal("cross-day replay double charged")
	}
	if _, _, err = store.ReserveCloudAllocation(ctx, 74, uuid.NewString(), "conversation", 300, 300); err != nil {
		t.Fatal("new UTC day not replenished")
	}
}
func TestCloudAllocationPostgresContract(t *testing.T) {
	fixture := cloudRunPostgresFixture(t)
	store := fixture.store.(*PersistentStore)
	if _, err := store.db.Exec(CloudAllocationSchema); err != nil {
		t.Fatal(err)
	}
	runCloudAllocationContract(t, store)
}

func TestCloudFileParserSharesConversationAllocationBudget(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	file := f.upload(t, "quota.pdf", []byte("%PDF-1.7\nsynthetic"))
	p, stub := parserForFixture(t, f, "success")
	if _, _, err := f.store.ReserveCloudAllocation(context.Background(), 1, "spent-conversation-budget", "conversation", 3600, CloudAllocationDefaultDailySeconds); err != nil {
		t.Fatal(err)
	}
	if err := p.process(context.Background(), 1, file.ID); !errors.Is(err, ErrCloudToolQuota) {
		t.Fatalf("parser did not honor common quota: %v", err)
	}
	stored, _ := f.store.GetCloudFile(context.Background(), 1, file.ID)
	if stored.State != CloudFileFailed || stored.ErrorCode != "allocation_limit" || stored.ParseTask == nil || !stored.ParseTask.VMStopped {
		t.Fatalf("quota outcome %+v", stored)
	}
	stub.mu.Lock()
	defer stub.mu.Unlock()
	if stub.seen["sandbox.create"] != 0 {
		t.Fatal("exhausted quota still allocated a VM")
	}
}
