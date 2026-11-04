package account

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCloudImageSettingsAccountAndCAS(t *testing.T) {
	for _, kind := range []string{"memory", "postgres"} {
		t.Run(kind, func(t *testing.T) {
			var store cloudImageSettingsStore
			if kind == "memory" {
				store = NewMemoryStore()
			} else {
				f := cloudRunPostgresFixture(t)
				p := f.store.(*PersistentStore)
				if _, err := p.db.Exec(CloudImageSettingsSchema); err != nil {
					t.Fatal(err)
				}
				store = p
			}
			ctx := context.Background()
			initial, err := store.GetCloudImageSettings(ctx, 1)
			if err != nil || initial.Model != "" || initial.Version != 0 {
				t.Fatal(initial, err)
			}
			var winners atomic.Int64
			var wg sync.WaitGroup
			for range 8 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					_, err := store.SetCloudImageSettings(ctx, 1, 0, CloudImageSettings{ProviderKeyID: 41, Model: "gpt-image-test"})
					if err == nil {
						winners.Add(1)
					} else if !errors.Is(err, errCloudImageSettingsConflict) {
						t.Error(err)
					}
				}()
			}
			wg.Wait()
			if winners.Load() != 1 {
				t.Fatal("lost concurrent preference update")
			}
			other, _ := store.GetCloudImageSettings(ctx, 2)
			if other.Model != "" {
				t.Fatal("cross-account setting")
			}
			cleared, err := store.SetCloudImageSettings(ctx, 1, 1, CloudImageSettings{})
			if err != nil || cleared.Model != "" || cleared.Version != 2 {
				t.Fatal(cleared, err)
			}
			if _, err = store.SetCloudImageSettings(ctx, 1, 1, CloudImageSettings{}); !errors.Is(err, errCloudImageSettingsConflict) {
				t.Fatal("stale write accepted", err)
			}
		})
	}
}

func imageTestPNG(t *testing.T) []byte {
	t.Helper()
	p := image.NewRGBA(image.Rect(0, 0, 12, 8))
	p.Set(2, 3, color.RGBA{40, 90, 180, 255})
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, p); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func imageExecutionFixture(t *testing.T, callback http.HandlerFunc) (*cloudFileHTTPFixture, *cloudRunToolExecution) {
	t.Helper()
	f := newCloudFileHTTPFixture(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/keys":
			io.WriteString(w, `{"code":0,"data":{"items":[{"id":41,"key":"synthetic-image-key","status":"active"}]}}`)
		case "/v1/models":
			io.WriteString(w, `{"data":[{"id":"gpt-image-test"}]}`)
		default:
			callback(w, r)
		}
	}))
	t.Cleanup(upstream.Close)
	f.service.usa = NewUSAClientWithHTTPClient(upstream.URL, upstream.Client())
	ctx := context.Background()
	session, err := f.store.GetSession(ctx, "file-owner")
	if err != nil {
		t.Fatal(err)
	}
	ref, err := f.store.BindCloudRunSession(ctx, session)
	if err != nil {
		t.Fatal(err)
	}
	input := cloudRunTestInput(t, cloudRunTestFixture{store: f.store, runs: f.store}, 1, f.conversation.ID, uuid.NewString(), "create illustration")
	input.SessionRef = ref
	if _, _, err = f.store.CreateCloudRun(ctx, input); err != nil {
		t.Fatal(err)
	}
	run, err := f.store.ClaimCloudRun(ctx, "image-worker", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	runtime := &cloudRunRuntime{service: f.service, store: f.store, sessions: f.store, config: DefaultCloudRuntimeConfig()}
	return f, &cloudRunToolExecution{runtime: runtime, store: f.store, run: run, owner: run.LeaseOwner}
}

func TestCloudImageGenerateEditDurableAndReplay(t *testing.T) {
	data := imageTestPNG(t)
	var posts atomic.Int64
	var identity string
	f, e := imageExecutionFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer synthetic-image-key" || r.Header.Get("Idempotency-Key") == "" {
			t.Error("missing private request authority")
		}
		posts.Add(1)
		identity = r.Header.Get("Idempotency-Key")
		if r.URL.Path == "/v1/images/generations" {
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			if body["model"] != "gpt-image-test" || body["output_format"] != "png" || body["response_format"] != nil {
				t.Error("incorrect image API fields", body)
			}
		} else if r.URL.Path == "/v1/images/edits" {
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Error(err)
			}
			defer r.MultipartForm.RemoveAll()
			refs := r.MultipartForm.File["image[]"]
			if len(refs) != 1 {
				t.Error("reference not transferred")
			}
		} else {
			t.Error("arbitrary image endpoint")
		}
		json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"b64_json": base64.StdEncoding.EncodeToString(data)}}})
	})
	ctx := context.Background()
	if _, err := f.store.SetCloudImageSettings(ctx, 1, 0, CloudImageSettings{ProviderKeyID: 41, Model: "gpt-image-test"}); err != nil {
		t.Fatal(err)
	}
	call := cloudModelToolCall{Name: "generate_image", ID: "first", Arguments: `{"prompt":"A quiet blue illustration","name":"illustration.png"}`}
	result, err := e.execute(ctx, 0, call)
	if err != nil {
		t.Fatal(err)
	}
	var receipt struct {
		Artifact *CloudArtifactVersion `json:"artifact"`
	}
	if json.Unmarshal(result, &receipt) != nil || receipt.Artifact == nil || receipt.Artifact.State != CloudArtifactReady {
		t.Fatalf("no durable receipt %s", result)
	}
	first := receipt.Artifact
	if identity != first.ToolOperationID && first.ToolOperationID != "" {
		t.Fatal("request identity lost")
	}
	again, err := e.execute(ctx, 0, call)
	if err != nil || string(again) != string(result) || posts.Load() != 1 {
		t.Fatal("paid operation repeated", err)
	}
	call.ID = "edit"
	call.Arguments = string(cloudJSON(map[string]any{"prompt": "Make it warmer", "name": "illustration-edited.png", "family_id": first.FamilyID, "references": []any{map[string]any{"artifact_version_id": first.ID}}}))
	result, err = e.execute(ctx, 1, call)
	if err != nil {
		t.Fatal(err)
	}
	json.Unmarshal(result, &receipt)
	if receipt.Artifact == nil || receipt.Artifact.FamilyID != first.FamilyID || receipt.Artifact.Number != 2 || posts.Load() != 2 {
		t.Fatal("edit replaced original", string(result))
	}
	original, err := f.store.GetCloudArtifactVersion(ctx, 1, first.ID)
	if err != nil || original.State != CloudArtifactReady {
		t.Fatal("original lost", err)
	}
	if _, err = f.store.GetCloudArtifactVersion(ctx, 2, first.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("artifact crossed owner", err)
	}
	run, _ := f.store.GetCloudRun(ctx, 1, e.run.ID)
	if !strings.Contains(string(run.Presentation), first.ID) || strings.Contains(string(run.Presentation), "synthetic-image-key") {
		t.Fatal("public image presentation invalid", string(run.Presentation))
	}
}

func TestCloudImageMissingModelAndUnknownNeverResubmit(t *testing.T) {
	var posts atomic.Int64
	f, e := imageExecutionFixture(t, func(w http.ResponseWriter, r *http.Request) { posts.Add(1); w.WriteHeader(503) })
	ctx := context.Background()
	call := cloudModelToolCall{Name: "generate_image", ID: "one", Arguments: `{"prompt":"illustrate a garden","name":"garden.png"}`}
	result, err := e.execute(ctx, 0, call)
	if err != nil || !strings.Contains(string(result), "needs_configuration") || posts.Load() != 0 {
		t.Fatal("missing setting invoked model", string(result), err)
	}
	run, _ := f.store.GetCloudRun(ctx, 1, e.run.ID)
	if !strings.Contains(string(run.Presentation), "请先选择默认生图模型") {
		t.Fatal("configuration CTA fact missing")
	}
	f.store.SetCloudImageSettings(ctx, 1, 0, CloudImageSettings{ProviderKeyID: 41, Model: "gpt-image-test"})
	_, err = e.execute(ctx, 1, call)
	var unknown *cloudToolRunError
	if !errors.As(err, &unknown) || !unknown.unknown {
		t.Fatal("unknown result claimed failed", err)
	}
	_, _ = e.execute(ctx, 1, call)
	if posts.Load() != 1 {
		t.Fatal("unknown paid operation resubmitted")
	}
	// Unowned references and quota are rejected before another paid request.
	call.Arguments = string(cloudJSON(map[string]any{"prompt": "edit", "name": "edit.png", "references": []any{map[string]any{"artifact_version_id": uuid.NewString()}}}))
	result, err = e.execute(ctx, 2, call)
	if err != nil || !strings.Contains(string(result), "image_reference_unavailable") || posts.Load() != 1 {
		t.Fatal("unowned reference reached provider", string(result), err)
	}
}

func TestCloudImageSkillsAvailableWithoutExecutor(t *testing.T) {
	f, e := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("skill read contacted image model") })
	_ = f
	names := map[string]bool{}
	for _, tool := range e.schemas() {
		fn := tool["function"].(map[string]any)
		names[fn["name"].(string)] = true
	}
	if !names["generate_image"] || !names["read_skill"] || names["execute_command"] {
		t.Fatal("incorrect capability discovery")
	}
	guidance := cloudCapabilityGuidance(time.Now(), CloudRunModelParameters{}, e.schemas())
	if !strings.Contains(guidance, "unless generate_image (images only) returns") || strings.Contains(guidance, "unless publish_artifact") {
		t.Fatal("image-only capability advertised sandbox publication", guidance)
	}
	for i, name := range []string{"imagegen", "product-design"} {
		data, err := e.execute(context.Background(), i, cloudModelToolCall{Name: "read_skill", Arguments: string(cloudJSON(map[string]any{"name": name}))})
		if err != nil || !strings.Contains(string(data), "instructions") {
			t.Fatal(name, err, string(data))
		}
	}
}

func TestCloudImageSettingsHTTPAuthority(t *testing.T) {
	f, _ := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("settings invoked image provider") })
	mux := http.NewServeMux()
	NewHTTPHandler(f.service, false).registerWebChat(mux)
	f.server.Close()
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	path := "/api/web-chat/image-settings"
	request := func(cookie string, expected, key int, model string, headers http.Header) int {
		body := cloudJSON(map[string]any{"expected_version": expected, "provider_key_id": key, "model": model})
		status, _, _ := f.request(t, "PUT", path, cookie, bytes.NewReader(body), headers)
		return status
	}
	status, _, headers := f.request(t, "GET", path, "file-owner", nil, nil)
	if status != 200 || headers.Get("Cache-Control") != "no-store" {
		t.Fatal(status, headers)
	}
	if status = request("file-owner", 0, 41, "gpt-image-test", nil); status != 200 {
		t.Fatal(status)
	}
	if status = request("file-owner", 0, 41, "gpt-image-test", nil); status != 409 {
		t.Fatal("CAS overwritten", status)
	}
	if status = request("file-owner", 1, 41, "invented", nil); status != 400 {
		t.Fatal("unavailable model accepted", status)
	}
	if status = request("file-owner", 1, 999, "gpt-image-test", nil); status == 200 {
		t.Fatal("foreign key accepted")
	}
	if status = request("file-owner", 1, 0, "", http.Header{"Origin": {"https://evil.invalid"}}); status != 403 {
		t.Fatal("cross-origin mutation", status)
	}
	status, body, _ := f.request(t, "GET", path, "file-other", nil, nil)
	if status != 200 || strings.Contains(string(body), "gpt-image-test") {
		t.Fatal("cross-account preference", status)
	}
}

func TestCloudImageRejectsUntrustedResultsWithoutFetchingURLs(t *testing.T) {
	for _, payload := range []string{`{"data":[{"url":"https://untrusted.invalid/image.png"}]}`, `{"data":[{"b64_json":"bm90IGFuIGltYWdl"}]}`} {
		t.Run(payload, func(t *testing.T) {
			var calls atomic.Int64
			peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); io.WriteString(w, payload) }))
			defer peer.Close()
			client := NewUSAClientWithHTTPClient(peer.URL, peer.Client())
			_, err := client.createCloudImage(context.Background(), "test-key", uuid.NewString(), CloudImageSettings{Model: "gpt-image-test"}, cloudImageRequest{Prompt: "test", Name: "test.png"}, nil)
			var failure *cloudToolRunError
			if !errors.As(err, &failure) || !failure.unknown || calls.Load() != 1 {
				t.Fatal("invalid result accepted or retried", err, calls.Load())
			}
		})
	}
}
