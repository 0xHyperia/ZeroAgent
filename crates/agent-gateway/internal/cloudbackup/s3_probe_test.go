package cloudbackup

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/objectstore"
)

type probeObject struct {
	data           []byte
	meta           map[string]string
	mime, checksum string
}
type probePeer struct {
	mu                             sync.Mutex
	mode                           string
	objects                        map[string]probeObject
	probeKeys                      map[string]bool
	probePuts, formalPuts, deletes int
	entered, release               chan struct{}
	blockOnce, releaseOnce         sync.Once
}

func newProbePeer(t *testing.T, mode string) (*S3, *probePeer) {
	t.Helper()
	p := &probePeer{mode: mode, objects: map[string]probeObject{}, probeKeys: map[string]bool{}, entered: make(chan struct{}), release: make(chan struct{})}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") {
			t.Error("unsigned probe or formal request")
		}
		isProbe := strings.Contains(r.URL.Path, "/"+restoreWriteProbePrefix)
		if mode == "block" && isProbe && r.Method == http.MethodPut {
			p.blockOnce.Do(func() {
				close(p.entered)
				select {
				case <-p.release:
				case <-r.Context().Done():
				}
			})
		}
		p.mu.Lock()
		defer p.mu.Unlock()
		if isProbe {
			p.probeKeys[r.URL.Path] = true
		}
		object, exists := p.objects[r.URL.Path]
		if mode == "preexisting" && isProbe && r.Method == http.MethodHead && !exists {
			w.WriteHeader(200)
			return
		}
		if r.Method == http.MethodPut {
			if r.Header.Get("If-None-Match") != "*" {
				t.Error("conditional PUT omitted If-None-Match: *")
			}
			if isProbe {
				p.probePuts++
			} else {
				p.formalPuts++
			}
			if exists && mode != "ignore" && mode != "reject-but-overwrite" {
				w.WriteHeader(412)
				return
			}
			data, _ := io.ReadAll(r.Body)
			meta := map[string]string{}
			for name, values := range r.Header {
				if strings.HasPrefix(strings.ToLower(name), "x-amz-meta-") {
					meta[strings.TrimPrefix(strings.ToLower(name), "x-amz-meta-")] = values[0]
				}
			}
			if mode == "unknown-foreign" {
				meta["zeroagent-restore-probe"] = "foreign-nonce"
			}
			object = probeObject{data: data, meta: meta, mime: r.Header.Get("Content-Type"), checksum: r.Header.Get("X-Amz-Checksum-Sha256")}
			p.objects[r.URL.Path] = object
			if mode == "unknown" || mode == "unknown-foreign" {
				conn, _, err := w.(http.Hijacker).Hijack()
				if err == nil {
					conn.Close()
				}
				return
			}
			if exists && mode == "reject-but-overwrite" {
				w.WriteHeader(412)
				return
			}
			w.Header().Set("X-Amz-Checksum-Sha256", object.checksum)
			w.WriteHeader(200)
			return
		}
		if r.Method == http.MethodDelete {
			p.deletes++
			if mode == "delete-failed" {
				w.WriteHeader(403)
				return
			}
			if mode != "delete-lies" {
				delete(p.objects, r.URL.Path)
			}
			w.WriteHeader(204)
			return
		}
		if !exists {
			w.WriteHeader(404)
			io.WriteString(w, "<Error><Code>NoSuchKey</Code></Error>")
			return
		}
		for key, value := range object.meta {
			w.Header().Set("X-Amz-Meta-"+key, value)
		}
		w.Header().Set("Content-Type", object.mime)
		w.Header().Set("Content-Length", strconv.Itoa(len(object.data)))
		w.Header().Set("X-Amz-Checksum-Sha256", object.checksum)
		if r.Method == http.MethodHead {
			return
		}
		w.Write(object.data)
	}))
	t.Cleanup(func() { p.releaseOnce.Do(func() { close(p.release) }); server.Close() })
	store, err := NewS3(objectstore.Config{Endpoint: server.URL, Bucket: "restore-probe", Region: "test-region", AccessKeyID: "synthetic-probe-access", SecretAccessKey: "synthetic-probe-secret", AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	return store, p
}

func TestRestoreWriteProbeAllowsOnlyVerifiedConditionalServiceAndSingleAttempt(t *testing.T) {
	store, peer := newProbePeer(t, "correct")
	peer.mu.Lock()
	if peer.probePuts != 0 || len(peer.probeKeys) != 0 {
		t.Fatal("NewS3 mutated remote state")
	}
	peer.mu.Unlock()
	for i := 0; i < 3; i++ {
		if err := store.CheckRestoreWriteSemantics(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	data := []byte("formal immutable bytes")
	if err := store.PutIfAbsent(context.Background(), "accounts/fixture/formal", bytes.NewReader(data), int64(len(data)), objectstore.PutOptions{ContentType: "text/plain", SHA256: testDigest(data)}); err != nil {
		t.Fatal(err)
	}
	peer.mu.Lock()
	defer peer.mu.Unlock()
	if peer.probePuts != 2 || len(peer.probeKeys) != 1 || peer.deletes != 1 || peer.formalPuts != 1 || len(peer.objects) != 1 {
		t.Fatal("probe duplicated, canary leaked, or formal write bypassed proof")
	}
	for key := range peer.probeKeys {
		if _, exists := peer.objects[key]; exists {
			t.Fatal("supported service retained probe object")
		}
	}
}

func TestRestoreWriteProbeRejectsUnsupportedOrUnconfirmedBeforeFormalWrites(t *testing.T) {
	for _, tc := range []struct {
		mode     string
		expected error
		clean    bool
		deletes  int
	}{
		{"ignore", ErrConditionalWritesUnsupported, true, 1},
		{"reject-but-overwrite", ErrConditionalWritesUnconfirmed, true, 1},
		{"unknown", ErrConditionalWritesUnconfirmed, true, 1},
		{"unknown-foreign", ErrConditionalWritesUnconfirmed, false, 0},
		{"delete-failed", ErrConditionalWritesUnconfirmed, false, 1},
		{"delete-lies", ErrConditionalWritesUnconfirmed, false, 1},
		{"preexisting", ErrConditionalWritesUnconfirmed, false, 0},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			store, peer := newProbePeer(t, tc.mode)
			data := []byte("must never reach formal key")
			err := store.PutIfAbsent(context.Background(), "accounts/fixture/formal", bytes.NewReader(data), int64(len(data)), objectstore.PutOptions{SHA256: testDigest(data)})
			if !errors.Is(err, tc.expected) {
				t.Fatalf("classification: %v", err)
			}
			var proof *ConditionalWriteError
			if !errors.As(err, &proof) || !strings.HasPrefix(proof.Probe.ProbeKey, restoreWriteProbePrefix) || len(strings.TrimPrefix(proof.Probe.ProbeKey, restoreWriteProbePrefix)) != 64 || proof.Probe.CleanupConfirmed != tc.clean {
				t.Fatal("unsafe or inaccurate probe diagnostics")
			}
			if strings.Contains(err.Error(), "127.0.0.1") || strings.Contains(err.Error(), "synthetic-probe") {
				t.Fatal("probe error exposed transport details")
			}
			if tc.mode == "ignore" && proof.Probe.ObservedPayload != "replacement" {
				t.Fatal("ignored condition's replacement was not observed before cleanup")
			}
			if repeat := store.CheckRestoreWriteSemantics(context.Background()); repeat != err {
				t.Fatal("failed client did not keep its exact sticky outcome")
			}
			peer.mu.Lock()
			defer peer.mu.Unlock()
			if len(peer.probeKeys) != 1 || peer.formalPuts != 0 || peer.deletes != tc.deletes {
				t.Fatal("unsafe mutation, cleanup, or nonce retry")
			}
		})
	}
}

func TestRestoreWriteProbeWaitersCancelIndependentlyAndOnlyOneLeaderWrites(t *testing.T) {
	store, peer := newProbePeer(t, "block")
	leader := make(chan error, 1)
	go func() { leader <- store.CheckRestoreWriteSemantics(context.Background()) }()
	select {
	case <-peer.entered:
	case <-time.After(time.Second):
		t.Fatal("leader did not start")
	}
	waitCtx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := store.CheckRestoreWriteSemantics(waitCtx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("waiting caller could not cancel independently")
	}
	var waiters sync.WaitGroup
	for i := 0; i < 12; i++ {
		waiters.Add(1)
		go func() {
			defer waiters.Done()
			if err := store.CheckRestoreWriteSemantics(context.Background()); err != nil {
				t.Error(err)
			}
		}()
	}
	peer.releaseOnce.Do(func() { close(peer.release) })
	if err := <-leader; err != nil {
		t.Fatal(err)
	}
	waiters.Wait()
	peer.mu.Lock()
	defer peer.mu.Unlock()
	if peer.probePuts != 2 || len(peer.probeKeys) != 1 || peer.deletes != 1 {
		t.Fatal("concurrent calls repeated capability writes")
	}
}

func TestRestoreWriteProbeInvalidOrCancelledInputMakesNoRemoteAttempt(t *testing.T) {
	store, peer := newProbePeer(t, "correct")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := store.CheckRestoreWriteSemantics(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := store.PutIfAbsent(context.Background(), "accounts/fixture/formal", bytes.NewReader([]byte("x")), 1, objectstore.PutOptions{SHA256: "invalid"}); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	for _, key := range []string{"", "../bad", "accounts//bad", "accounts/./bad", "accounts/bad/", "bad\\path", restoreWriteProbePrefix + strings.Repeat("a", 64)} {
		if err := store.PutIfAbsent(context.Background(), key, bytes.NewReader([]byte("x")), 1, objectstore.PutOptions{SHA256: testDigest([]byte("x"))}); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid key caused capability attempt")
		}
	}
	peer.mu.Lock()
	defer peer.mu.Unlock()
	if len(peer.probeKeys) != 0 || peer.probePuts != 0 || peer.formalPuts != 0 {
		t.Fatal("invalid/cancelled input caused network mutation")
	}
}

func TestRestoreWriteProbeLeaderCancellationKeepsStickyUnconfirmed(t *testing.T) {
	store, peer := newProbePeer(t, "block")
	ctx, cancel := context.WithCancel(context.Background())
	leader := make(chan error, 1)
	go func() { leader <- store.CheckRestoreWriteSemantics(ctx) }()
	select {
	case <-peer.entered:
	case <-time.After(time.Second):
		t.Fatal("leader did not start")
	}
	cancel()
	var err error
	select {
	case err = <-leader:
	case <-time.After(7 * time.Second):
		t.Fatal("cancelled probe did not finish bounded cleanup")
	}
	if !errors.Is(err, ErrConditionalWritesUnconfirmed) {
		t.Fatal("cancelled leader became supported/unsupported")
	}
	if repeat := store.CheckRestoreWriteSemantics(context.Background()); repeat != err {
		t.Fatal("cancelled leader automatically retried a new nonce")
	}
	peer.mu.Lock()
	defer peer.mu.Unlock()
	if len(peer.probeKeys) != 1 || peer.formalPuts != 0 || peer.probePuts > 1 {
		t.Fatal("cancelled leader dispatched additional writes")
	}
}
