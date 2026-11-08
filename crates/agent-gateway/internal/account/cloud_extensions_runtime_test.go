package account

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/kbrain"
)

// Run with ZEROAGENT_TEST_KBRAIN_BINARY pointing to a verified, patched K-brain
// release artifact. All accounts, providers and workspaces are loopback fixtures.
func TestCloudAndDeviceRunSamePinnedAccountSkill(t *testing.T) {
	binary := os.Getenv("ZEROAGENT_TEST_KBRAIN_BINARY")
	if binary == "" {
		t.Skip("set ZEROAGENT_TEST_KBRAIN_BINARY to the prepared K-brain executable")
	}
	const oldMarker = "ZA-SKILL-PIN-REVISION-ONE"
	const newMarker = "ZA-SKILL-PIN-REVISION-TWO"
	const referenceFile = "references/acceptance.md"
	const referenceBody = "Synthetic reference for the cross-runtime acceptance check."
	const fixtureCookie = "synthetic-browser-cookie"
	const capability = "synthetic-device-capability-0123456789abcdef"
	old := extensionTestRevision("After reading the reference, reply with " + oldMarker)
	old.Files[referenceFile] = referenceBody
	newer := extensionTestRevision("After reading the reference, reply with " + newMarker)
	newer.Files[referenceFile] = "Different reference in revision two."
	ownerBearer := "header." + base64.RawURLEncoding.EncodeToString(cloudJSON(map[string]any{
		"token_use": "app", "client_id": "zeroagent-desktop", "sub": "1",
		"grant_id": "fixture-grant", "session_id": "fixture-session", "family_id": "fixture-family",
		"exp": time.Now().Add(time.Hour).Unix(),
	})) + ".signature"
	var packageID string
	catalogSaved := make(chan struct{})
	var readCalls atomic.Int32
	f := newCloudHTTPFixtureWithPlatform(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-catalogSaved:
		case <-r.Context().Done():
			return
		}
		var input struct {
			Tools []struct {
				Function struct{ Name string }
			}
			Messages []struct{ Role, Content string }
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			http.Error(w, "unexpected model input", http.StatusBadRequest)
			return
		}
		if readCalls.Add(1) == 1 {
			available := false
			for _, tool := range input.Tools {
				available = available || tool.Function.Name == "read_skill"
			}
			if !available {
				t.Error("Gateway did not advertise read_skill")
			}
			for i, file := range []string{"SKILL.md", referenceFile} {
				emitToolCalls(w, map[string]any{"index": i, "id": fmt.Sprintf("file-%d", i), "type": "function", "function": map[string]any{
					"name": "read_skill", "arguments": string(cloudJSON(map[string]string{"name": "weekly-review", "package_id": packageID, "file": file})),
				}})
			}
			emitModelFinish(w, "tool_calls", 3)
			return
		}
		files := map[string]bool{}
		for _, msg := range input.Messages {
			if msg.Role != "tool" {
				continue
			}
			var result struct {
				PackageID    string `json:"package_id"`
				Version      int64
				Instructions string
			}
			if json.Unmarshal([]byte(msg.Content), &result) == nil && result.PackageID == packageID && result.Version == 1 {
				files[result.Instructions] = true
			}
		}
		if !files[old.Files["SKILL.md"]] || !files[referenceBody] {
			t.Error("Cloud Run did not pass the exact pinned skill and reference bytes to the provider")
			http.Error(w, "pinned skill unavailable", http.StatusBadRequest)
			return
		}
		emitCloudDelta(w, oldMarker)
		emitModelFinish(w, "stop", 3)
	}, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/app/me" || r.Header.Get("Authorization") != "Bearer "+ownerBearer {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = io.WriteString(w, `{"success":true,"data":{"id":1}}`)
	})
	save := func(version int, revision CloudExtensionRevision) {
		t.Helper()
		body := cloudJSON(map[string]any{"expected_version": version, "action": "save", "kind": "skill", "id": packageID, "revision": revision})
		status, data := f.request(t, http.MethodPost, "/api/web-chat/extensions", fixtureCookie, string(body))
		if status != http.StatusOK {
			t.Fatalf("save account skill revision: %d %s", status, data)
		}
		var catalog struct{ Packages []cloudExtensionCard }
		if json.Unmarshal([]byte(data), &catalog) != nil {
			t.Fatal("unexpected catalog response")
		}
		for _, card := range catalog.Packages {
			if card.Owned && card.Name == old.Name && card.Version == int64(version+1) {
				packageID = card.ID
				return
			}
		}
		t.Fatal("saved revision missing from the authenticated catalog")
	}
	save(0, old)
	save(1, newer)
	close(catalogSaved)
	prompt := fmt.Sprintf("Use [Weekly review](zeroagent-skill:%s/1/weekly-review).", packageID)
	run, cloudRequest := f.create(t, "pinned-account-skill-cloud", prompt)
	cloud := f.wait(t, run.ID, (*CloudRun).Terminal)
	if cloud.State != CloudRunCompleted || cloud.Output != oldMarker {
		t.Fatalf("Cloud Run did not complete with revision one: state=%s error=%s rounds=%d", cloud.State, cloud.ErrorCode, readCalls.Load())
	}

	var brokerCalls atomic.Int32
	broker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Protocol   string
			References []cloudDeviceSkillRef
		}
		if r.Method != http.MethodPost || r.URL.Path != "/v1/device/skills" ||
			r.Header.Get("Authorization") != "Bearer "+capability ||
			json.NewDecoder(r.Body).Decode(&input) != nil || input.Protocol != "zeroagent.device-skill-snapshot.v1" ||
			len(input.References) != 1 || input.References[0] != (cloudDeviceSkillRef{packageID, 1, "weekly-review"}) {
			t.Error("unexpected K-brain snapshot request")
			http.Error(w, "invalid device request", http.StatusBadRequest)
			return
		}
		brokerCalls.Add(1)
		body := cloudJSON(map[string]any{"references": input.References})
		request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, f.server.URL+cloudDeviceSkillSnapshotPath, bytes.NewReader(body))
		if err != nil {
			http.Error(w, "build snapshot request", http.StatusInternalServerError)
			return
		}
		request.Header.Set("Authorization", "Bearer "+ownerBearer)
		request.Header.Set("X-ZeroAgent-Account-ID", "1")
		response, err := f.server.Client().Do(request)
		if err != nil {
			http.Error(w, "Gateway unavailable", http.StatusBadGateway)
			return
		}
		defer response.Body.Close()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(response.StatusCode)
		_, _ = io.Copy(w, response.Body)
	}))
	t.Cleanup(broker.Close)
	var deviceModelCalls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Stream   bool
			Messages []struct {
				Role    string
				Content json.RawMessage
			}
		}
		if r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer fixture-device-model-key" ||
			json.NewDecoder(r.Body).Decode(&request) != nil {
			http.Error(w, "invalid device model request", http.StatusBadRequest)
			return
		}
		if !request.Stream {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"Fixture skill check"},"finish_reason":"stop"}]}`)
			return
		}
		deviceModelCalls.Add(1)
		var snapshot []cloudDeviceSkill
		for _, message := range request.Messages {
			if message.Role != "user" {
				continue
			}
			var parts []kbrain.ContentBlock
			var text string
			if json.Unmarshal(message.Content, &text) == nil {
				parts = []kbrain.ContentBlock{{Type: "text", Text: text}}
			} else {
				_ = json.Unmarshal(message.Content, &parts)
			}
			for _, part := range parts {
				const start = "[{"
				if _, jsonPart, found := strings.Cut(part.Text, "\n"+start); found {
					_ = json.NewDecoder(strings.NewReader(start + jsonPart)).Decode(&snapshot)
				}
			}
		}
		if len(snapshot) != 1 || snapshot[0].cloudDeviceSkillRef != (cloudDeviceSkillRef{packageID, 1, "weekly-review"}) ||
			snapshot[0].Files["SKILL.md"] != old.Files["SKILL.md"] || snapshot[0].Files[referenceFile] != referenceBody {
			t.Error("K-brain did not pass the exact pinned skill and reference bytes to the provider")
			http.Error(w, "pinned skill unavailable", http.StatusBadRequest)
			return
		}
		emitCloudDelta(w, oldMarker)
		emitModelFinish(w, "stop", 3)
	}))
	t.Cleanup(provider.Close)
	device := startPinnedSkillBackend(t, binary, provider.URL, broker.URL, capability)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	id, err := device.CreateSession(ctx, t.TempDir(), kbrain.ModelRef{Provider: "fixture", Model: "test-model"})
	if err != nil {
		t.Fatal(err)
	}
	accepted, _, err := device.StartRun(ctx, id, kbrain.PromptRequest{ConversationID: id, ClientRequestID: "pinned-account-skill-device", Prompt: prompt, Options: &kbrain.RunOptions{Mode: "chat"}})
	if err != nil {
		t.Fatal(err)
	}
	var terminal string
	err = device.EventsForRun(ctx, id, 0, accepted.RunID, func(event kbrain.Event) error {
		if event.RunID == accepted.RunID && strings.HasPrefix(event.Type, "run.") {
			terminal = event.Type
		}
		return nil
	})
	if err != nil || terminal != "run.completed" || brokerCalls.Load() != 1 {
		t.Fatalf("Device Run did not complete with one fixed snapshot: terminal=%s, calls=%d, error=%v", terminal, brokerCalls.Load(), err)
	}
	history, err := device.GetHistory(ctx, id, 12, nil)
	if err != nil {
		t.Fatal(err)
	}
	original, sameOutput := false, false
	for _, message := range history.Session.Messages {
		for _, part := range message.Content {
			original = original || (message.Role == "user" && part.Text == prompt)
			sameOutput = sameOutput || (message.Role == "assistant" && part.Text == cloud.Output)
			if message.Role == "user" && strings.Contains(part.Text, oldMarker) {
				t.Fatal("model-only skill source entered device conversation history")
			}
		}
	}
	if !original || !sameOutput {
		t.Fatal("device history did not preserve the original prompt and the Cloud Run output")
	}
	t.Log("Cloud Run and K-brain both completed using the exact revision-one instruction and reference after revision two was published")

	cloudCalls, deviceCalls := readCalls.Load(), deviceModelCalls.Load()
	status, response := f.request(t, http.MethodPost, "/api/web-chat/extensions", fixtureCookie,
		string(cloudJSON(map[string]any{"expected_version": 2, "action": "enable", "id": packageID, "enabled": false})))
	if status != http.StatusOK {
		t.Fatalf("disable the account skill: %d %s", status, response)
	}
	status, response = f.request(t, http.MethodPost, "/api/web-chat/runs", fixtureCookie, cloudRequest)
	if status != http.StatusOK || !strings.Contains(response, cloud.ID) {
		t.Fatalf("previously accepted request no longer returns its original receipt: %d", status)
	}
	retry := strings.Replace(cloudRequest, "pinned-account-skill-cloud", "pinned-account-skill-disabled", 1)
	status, response = f.request(t, http.MethodPost, "/api/web-chat/runs", fixtureCookie, retry)
	if status != http.StatusUnprocessableEntity || !strings.Contains(response, "skill_reference_unavailable") {
		t.Fatalf("new Cloud Run did not reject the disabled revision: %d %s", status, response)
	}
	state, code := f.service.cloudRuntime.generateWithTools(ctx, cloud, "fixture-worker", &cloudRunExecutionFacts{})
	if state != CloudRunFailed || code != "skill_reference_unavailable" {
		t.Fatalf("Cloud worker did not revalidate the fixed revision before the first model request: %s %s", state, code)
	}
	_, status, err = device.StartRun(ctx, id, kbrain.PromptRequest{
		ConversationID: id, ClientRequestID: "pinned-account-skill-device-disabled", Prompt: prompt,
		Options: &kbrain.RunOptions{Mode: "chat"},
	})
	if err == nil || status != http.StatusUnprocessableEntity || brokerCalls.Load() != 2 ||
		readCalls.Load() != cloudCalls || deviceModelCalls.Load() != deviceCalls {
		t.Fatalf("disabled references reached execution or used a stale snapshot: status=%d broker=%d cloud=%d device=%d",
			status, brokerCalls.Load(), readCalls.Load()-cloudCalls, deviceModelCalls.Load()-deviceCalls)
	}
	t.Log("Both runtimes rejected the disabled revision before the provider; the accepted Cloud receipt stayed readable")
}

func startPinnedSkillBackend(t *testing.T, binary, provider, broker, capability string) *kbrain.Client {
	t.Helper()
	root := t.TempDir()
	binary, err := filepath.Abs(binary)
	if err != nil {
		t.Fatal(err)
	}
	config := fmt.Sprintf(`{"defaultModel":"test-model","memory":{"enabled":false},"providers":{"fixture":{"api":"openai-completions","baseUrl":%q,"apiKey":"fixture-device-model-key","models":[{"id":"test-model","contextWindow":8192,"maxTokens":256}]}}}`, provider)
	if err := os.WriteFile(filepath.Join(root, "config.json"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binary, "backend", "-listen", "127.0.0.1:0", "-data-dir", root, "-parent-stdio")
	cmd.Dir = root
	cmd.Env = []string{
		"K_BRAIN_BACKEND_TOKEN=fixture-backend-token", "ZEROAGENT_DEVICE_SKILL_ENDPOINT=" + broker + "/v1/device/skills",
		"ZEROAGENT_DEVICE_SKILL_TOKEN=" + capability, "HOME=" + root, "USERPROFILE=" + root,
		"APPDATA=" + root, "LOCALAPPDATA=" + root, "TMPDIR=" + root, "TMP=" + root, "TEMP=" + root,
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	ready, done := make(chan string, 1), make(chan struct{})
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			if url, found := strings.CutPrefix(scanner.Text(), "k-brain backend listening on "); found {
				ready <- url
			}
		}
		_ = cmd.Wait()
		close(done)
	}()
	t.Cleanup(func() {
		_ = stdin.Close()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
	})
	select {
	case address := <-ready:
		client, err := kbrain.New(address, "fixture-backend-token", nil)
		if err != nil {
			t.Fatal(err)
		}
		return client
	case <-done:
		t.Fatalf("K-brain exited before startup: %s", stderr.String())
	case <-time.After(10 * time.Second):
		t.Fatal("K-brain did not announce its loopback address")
	}
	return nil
}
