package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/liveagent/agent-gateway/internal/account"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

func completeTestSamples(t *testing.T) (string, []fileReference) {
	t.Helper()
	root := t.TempDir()
	refs := []fileReference{}
	for _, ext := range []string{".docx", ".xlsx"} {
		var data bytes.Buffer
		z := zip.NewWriter(&data)
		w, err := z.Create("[Content_Types].xml")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte("<Types>synthetic parser fixture</Types>"))
		if err = z.Close(); err != nil {
			t.Fatal(err)
		}
		ref := fileReference{Type: "file_reference", FileID: stableID(1, "test-sample"+ext), Name: "合成样本" + ext, MIME: "application/zip", Size: int64(data.Len()), SHA256: digest(data.Bytes())}
		if err = os.WriteFile(filepath.Join(root, ref.Name), data.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
		refs = append(refs, ref)
	}
	return root, refs
}
func TestCompleteFixturePlanContainsInertQueueDraftAndCanonicalOutputs(t *testing.T) {
	root, refs := completeTestSamples(t)
	plans, err := buildCompleteFixtures(1, refs, root)
	if err != nil {
		t.Fatal(err)
	}
	again, err := buildCompleteFixtures(1, refs, root)
	if err != nil || !bytes.Equal(encoded(plans), encoded(again)) {
		t.Fatal("complete plan is not deterministic", err)
	}
	if len(plans) != 3 {
		t.Fatal("missing complete fixture conversations")
	}
	x := plans[0].Extras
	if x.Run == nil || !x.Run.Terminal() || x.Run.Attempt != 0 || x.Run.LeaseOwner != "" || !x.Run.LeaseUntil.IsZero() || len(x.Artifacts) != 4 || len(x.Tools) != 5 || x.Source == nil {
		t.Fatal("synthetic lineage must be terminal, complete and lease-free")
	}
	if x.Artifacts[2].Artifact.FamilyID != x.Artifacts[3].Artifact.FamilyID || x.Artifacts[2].Artifact.ID == x.Artifacts[3].Artifact.ID || x.Artifacts[3].Artifact.Number != 2 {
		t.Fatal("site releases must be immutable versions of one family")
	}
	for _, a := range x.Artifacts {
		if a.Artifact.Size != int64(len(a.Data)) || a.Artifact.SHA256 != digest(a.Data) || a.Artifact.SourceRunID != x.Run.ID {
			t.Fatal("artifact bytes or lineage mismatched")
		}
	}
	if plans[1].Extras.Queue == nil || len(plans[1].Extras.Queue.Items) != 3 || plans[1].Extras.Run != nil {
		t.Fatal("pending fixture must remain inert")
	}
	for _, item := range plans[1].Extras.Queue.Items {
		if item.Version != 1 || item.Presentation != "work" || len(item.Composer) == 0 {
			t.Fatal("pending item misses recoverable composer")
		}
	}
	var draft map[string]json.RawMessage
	if json.Unmarshal(plans[2].Extras.Draft, &draft) != nil || len(draft["draft"]) == 0 || plans[2].Extras.Run != nil {
		t.Fatal("private draft must remain editor state")
	}
	var p account.CloudPresentation
	_ = json.Unmarshal(plans[0].Messages[1].Presentation, &p)
	ids := map[string]bool{}
	resources := 0
	for _, b := range p.Blocks {
		if ids[b.ID] {
			t.Fatal("duplicated segment ID")
		}
		ids[b.ID] = true
		resources += len(b.Resources)
	}
	if !ids["reasoning:0:2"] || !ids["text:0:2"] || resources != 5 {
		t.Fatal("alternating blocks or output references missing")
	}
}
func TestCompleteFixtureSamplesAreReceiptBounded(t *testing.T) {
	root, refs := completeTestSamples(t)
	refs[0].SHA256 = digest([]byte("changed"))
	if _, _, err := readFixtureSample(root, refs, ".docx"); err == nil {
		t.Fatal("changed sample accepted")
	}
	if _, err := buildCompleteFixtures(1, nil, root); err == nil {
		t.Fatal("complete plan requires receipt-owned samples")
	}
	refs[0].Name = "../escape.docx"
	if _, _, err := readFixtureSample(root, refs, ".docx"); err == nil {
		t.Fatal("sample directory escape accepted")
	}
}

type fixtureMemoryObjects struct {
	data     []byte
	mime     string
	sha256   string
	metadata map[string]string
	puts     int
	unknown  bool
}

func (s *fixtureMemoryObjects) Get(_ context.Context, _ string) (*objectstore.Object, error) {
	if s.data == nil {
		return nil, objectstore.ErrNotFound
	}
	return &objectstore.Object{ObjectInfo: objectstore.ObjectInfo{Size: int64(len(s.data)), ContentType: s.mime, SHA256: s.sha256, Metadata: s.metadata}, Body: io.NopCloser(bytes.NewReader(s.data))}, nil
}
func (s *fixtureMemoryObjects) PutIfAbsent(_ context.Context, _ string, r io.ReadSeeker, _ int64, o objectstore.PutOptions) error {
	s.puts++
	if s.data != nil {
		return errors.New("exists")
	}
	s.data, _ = io.ReadAll(r)
	s.mime = o.ContentType
	s.sha256 = o.SHA256
	s.metadata = o.Metadata
	if s.unknown {
		return errors.New("response lost")
	}
	return nil
}
func TestFixtureObjectConditionalRetryNeverOverwritesExistingContent(t *testing.T) {
	a := fixtureArtifact{Artifact: account.CloudArtifactVersion{ObjectKey: "accounts/test/artifacts/test/test/content", MIME: "text/plain", Size: 5, SHA256: digest([]byte("hello"))}, Data: []byte("hello")}
	store := &fixtureMemoryObjects{unknown: true}
	if err := ensureFixtureObject(context.Background(), store, a); err != nil {
		t.Fatal(err)
	}
	if err := ensureFixtureObject(context.Background(), store, a); err != nil || store.puts != 1 {
		t.Fatal("same-key retry should read committed bytes", err)
	}
	store.data = []byte("other")
	if err := ensureFixtureObject(context.Background(), store, a); err == nil || store.puts != 1 {
		t.Fatal("modified object must be preserved")
	}
}
func TestFixtureObjectConfigurationRejectsRemoteEndpoint(t *testing.T) {
	for _, target := range []string{"https://s3.example.com", "http://172.16.0.121:8333", "http://localhost:8333", "http://127.0.0.1:8333?redirect=elsewhere"} {
		t.Setenv("ZEROAGENT_OBJECT_STORAGE_ENDPOINT", target)
		if store, err := openFixtureObjects(); err == nil {
			store.Close()
			t.Fatalf("remote or indirect endpoint accepted: %s", target)
		}
	}
}

func TestFixtureObjectRequiresCanonicalOwnershipMetadata(t *testing.T) {
	a := fixtureArtifact{Artifact: account.CloudArtifactVersion{UserID: 6649, ID: stableID(6649, "version"), FamilyID: stableID(6649, "family"), ObjectKey: "accounts/test/artifacts/test/test/content", MIME: "text/plain", Size: 5, SHA256: digest([]byte("hello"))}, Data: []byte("hello")}
	for _, key := range []string{"artifact-version", "artifact-family", "owner-scope"} {
		t.Run(key, func(t *testing.T) {
			store := &fixtureMemoryObjects{}
			if err := ensureFixtureObject(context.Background(), store, a); err != nil {
				t.Fatal(err)
			}
			if store.metadata["owner-scope"] != "account-"+digest([]byte("6649"))[:32] {
				t.Fatal("incorrect account scope")
			}
			delete(store.metadata, key)
			if err := ensureFixtureObject(context.Background(), store, a); err == nil || store.puts != 1 {
				t.Fatal("missing ownership metadata must fail without overwriting existing object")
			}
			store.metadata[key] = "another-owner-or-version"
			if err := verifyFixtureObject(context.Background(), store, a); err == nil {
				t.Fatal("mismatched ownership metadata accepted")
			}
		})
	}
}
