package wscore

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestWriteSyncRechecksAuthorization(t *testing.T) {
	conn := NewConn(nil, Config{BeforeWrite: func() bool { return false }})
	defer conn.Close()
	conn.writeOverride = func(Frame) error {
		t.Fatal("hello was written after authorization expired")
		return nil
	}
	if err := conn.WriteSync(Frame{Class: FrameResponse, Kind: "hello", MessageType: 2}); err == nil {
		t.Fatal("WriteSync accepted an expired authorization")
	}
}

func TestWriterRechecksAuthorizationAfterQueueing(t *testing.T) {
	var allowed atomic.Bool
	allowed.Store(true)
	var writes atomic.Int64
	conn := NewConn(nil, Config{BeforeWrite: func() bool { return allowed.Load() }})
	conn.writeOverride = func(Frame) error { writes.Add(1); return nil }
	if err := conn.Enqueue(Frame{Class: FrameResponse, MessageType: 2, Data: []byte("synthetic user data")}); err != nil {
		t.Fatal(err)
	}
	allowed.Store(false)
	conn.StartWriteLoop()
	select {
	case <-conn.Done():
	case <-time.After(time.Second):
		t.Fatal("revoked writer was not closed")
	}
	if got := writes.Load(); got != 0 {
		t.Fatalf("queued user data written after revocation: %d", got)
	}
}
