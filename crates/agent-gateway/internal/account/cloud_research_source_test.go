package account

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func researchFixture(t *testing.T, postgres bool) cloudToolFixture {
	t.Helper()
	if !postgres {
		return memoryCloudToolFixture(t)
	}
	f := postgresCloudToolFixture(t)
	store := f.store.(*PersistentStore)
	if _, err := store.db.Exec(CloudFileSchema + CloudProjectSchema + CloudBranchSchema + CloudResearchSourceSchema); err != nil {
		t.Fatal(err)
	}
	return f
}
func researchOperation(t *testing.T, f cloudToolFixture, run *CloudRun, name, call string, start bool) *CloudToolOperation {
	t.Helper()
	ctx := context.Background()
	op, _, err := f.tools.PrepareCloudTool(ctx, run.UserID, run.ID, run.LeaseOwner, run.Attempt, &CloudToolOperation{CallKey: call, Name: name, Input: json.RawMessage(`{"synthetic":true}`)})
	if err != nil {
		t.Fatal(err)
	}
	if start {
		op, err = f.tools.StartCloudTool(ctx, run.UserID, op.ID, run.LeaseOwner, run.Attempt)
		if err != nil {
			t.Fatal(err)
		}
	}
	return op
}
func researchPage() CloudResearchSourceInput {
	text := "第一行合成资料\n第二行合成资料\n第三行合成资料"
	return CloudResearchSourceInput{Kind: CloudResearchPage, URL: "https://example.com/original", FinalURL: "https://example.com/final", Title: "合成网页", Text: text, SHA256: cloudResearchDigest(text), BodySHA256: cloudResearchDigest("synthetic original HTML"), ObservedAt: time.Now().UTC(), Truncated: true}
}
func researchSnippet() CloudResearchSourceInput {
	return CloudResearchSourceInput{Kind: CloudResearchSearchSnippet, URL: "https://example.com/search", Title: "合成搜索条目", Snippet: "只是搜索摘要，未抓取网页", ObservedAt: time.Now().UTC()}
}

func TestCloudResearchSourceMemoryContract(t *testing.T)   { runResearchSourceContract(t, false) }
func TestCloudResearchSourcePostgresContract(t *testing.T) { runResearchSourceContract(t, true) }
func runResearchSourceContract(t *testing.T, postgres bool) {
	ctx := context.Background()
	t.Run("fence execution dedupe and account ownership", func(t *testing.T) {
		f := researchFixture(t, postgres)
		sources := f.store.(CloudResearchSourceStore)
		run := toolRunningRun(t, f, 7, "")
		op := researchOperation(t, f, run, "fetch_page", "round:0:call:0", false)
		input := researchPage()
		if _, err := sources.PersistCloudResearchSources(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, op.ID, []CloudResearchSourceInput{input}); !errors.Is(err, ErrCloudToolConflict) {
			t.Fatal("prepared tool published a source")
		}
		if _, err := f.tools.StartCloudTool(ctx, 7, op.ID, run.LeaseOwner, run.Attempt); err != nil {
			t.Fatal(err)
		}
		if _, err := sources.PersistCloudResearchSources(ctx, 7, run.ID, "wrong-owner", run.Attempt, op.ID, []CloudResearchSourceInput{input}); !errors.Is(err, ErrCloudRunLeaseLost) {
			t.Fatal("wrong lease published")
		}
		if _, err := sources.PersistCloudResearchSources(ctx, 7, run.ID, run.LeaseOwner, run.Attempt+1, op.ID, []CloudResearchSourceInput{input}); !errors.Is(err, ErrCloudRunLeaseLost) {
			t.Fatal("stale attempt published")
		}
		var wg sync.WaitGroup
		ids := make(chan string, 4)
		for range 4 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				published, err := sources.PersistCloudResearchSources(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, op.ID, []CloudResearchSourceInput{input})
				if err != nil {
					t.Error(err)
					return
				}
				ids <- published[0].ID
			}()
		}
		wg.Wait()
		close(ids)
		first := ""
		for id := range ids {
			if first == "" {
				first = id
			} else if first != id {
				t.Fatal("uncertain publication produced another source ID")
			}
		}
		if first == "" {
			t.Fatal("no source was published")
		}
		changed := input
		changed.Title = "changed title"
		if _, err := sources.PersistCloudResearchSources(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, op.ID, []CloudResearchSourceInput{changed}); !errors.Is(err, ErrCloudResearchSourceConflict) {
			t.Fatal("same operation accepted a changed source batch")
		}
		if _, err := sources.GetCloudResearchSource(ctx, 8, first); !errors.Is(err, ErrNotFound) {
			t.Fatal("foreign source exposed")
		}
		if _, err := sources.ListCloudResearchSources(ctx, 8, run.ConversationID, "", 50); !errors.Is(err, ErrNotFound) {
			t.Fatal("foreign conversation source list exposed")
		}
		source, err := sources.GetCloudResearchSource(ctx, 7, first)
		if err != nil || source.Text != input.Text || source.LineCount != 3 || source.SHA256 != input.SHA256 {
			t.Fatal("snapshot provenance or text changed")
		}
		if available, err := sources.CloudResearchSourceAvailable(ctx, 7, first); err != nil || !available {
			t.Fatal("owned source head unavailable")
		}
		if available, err := sources.CloudResearchSourceAvailable(ctx, 8, first); err != nil || available {
			t.Fatal("foreign source head exposed")
		}
		encoded, _ := json.Marshal(source)
		if strings.Contains(string(encoded), input.Text) || strings.Contains(string(encoded), op.ID) || strings.Contains(string(encoded), "user_id") {
			t.Fatal("private source body/operation escaped metadata JSON")
		}
		library, err := sources.ListCloudResearchSources(ctx, 7, "", "", 50)
		if err != nil || len(library) != 1 || library[0].Text != "" || library[0].TextBytes != len(input.Text) {
			t.Fatal("library loaded private bodies or lost byte counts")
		}
		f.expire(run.ID)
		if _, err = sources.PersistCloudResearchSources(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, op.ID, []CloudResearchSourceInput{input}); !errors.Is(err, ErrCloudRunLeaseLost) {
			t.Fatal("expired publisher replayed a publication")
		}
	})
	t.Run("search reserve is durable idempotent and concurrent bounded", func(t *testing.T) {
		f := researchFixture(t, postgres)
		sources := f.store.(CloudResearchSourceStore)
		run := toolRunningRun(t, f, 7, "")
		op := researchOperation(t, f, run, "web_search", "round:0:call:0", true)
		input := researchSnippet()
		if _, err := sources.PersistCloudResearchSources(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, op.ID, []CloudResearchSourceInput{input}); !errors.Is(err, ErrCloudResearchSourceQuota) {
			t.Fatal("unreserved search published")
		}
		var created atomic.Int32
		var wg sync.WaitGroup
		for range 4 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				fresh, err := sources.ReserveCloudResearchSearch(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, op.ID, 1)
				if err != nil {
					t.Error(err)
				}
				if fresh {
					created.Add(1)
				}
			}()
		}
		wg.Wait()
		if created.Load() != 1 {
			t.Fatal("one operation reserved multiple billable searches")
		}
		published, err := sources.PersistCloudResearchSources(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, op.ID, []CloudResearchSourceInput{input})
		if err != nil || len(published) != 1 || published[0].Kind != CloudResearchSearchSnippet || published[0].Text != "" || published[0].LineCount != 0 {
			t.Fatal("search summary pretended to be a page")
		}
		if err = f.store.DeleteCloudConversation(ctx, 7, run.ConversationID); err != nil {
			t.Fatal(err)
		}
		if _, err = sources.GetCloudResearchSource(ctx, 7, published[0].ID); err != nil {
			t.Fatal("conversation deletion cascaded source snapshot")
		}
		next := toolRunningRun(t, f, 7, "")
		nextOp := researchOperation(t, f, next, "web_search", "round:0:call:0", true)
		if _, err = sources.ReserveCloudResearchSearch(ctx, 7, next.ID, next.LeaseOwner, next.Attempt, nextOp.ID, 1); !errors.Is(err, ErrCloudResearchSourceQuota) {
			t.Fatal("conversation deletion refunded an unknown or completed search reservation")
		}
	})
	t.Run("branch source remains readable and explicit delete does not resurrect", func(t *testing.T) {
		f := researchFixture(t, postgres)
		sources := f.store.(CloudResearchSourceStore)
		run := toolRunningRun(t, f, 7, "")
		op := researchOperation(t, f, run, "fetch_page", "round:0:call:0", true)
		input := researchPage()
		published, err := sources.PersistCloudResearchSources(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, op.ID, []CloudResearchSourceInput{input})
		if err != nil {
			t.Fatal(err)
		}
		source := published[0]
		if _, err = f.tools.CommitCloudTool(ctx, 7, op.ID, run.LeaseOwner, run.Attempt, CloudToolSucceeded, cloudJSON(map[string]any{"source_id": source.ID}), ""); err != nil {
			t.Fatal(err)
		}
		if _, err = f.runs.CommitCloudRun(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, CloudRunCommit{OperationID: "finish-source-run", State: CloudRunCompleted, Delta: "合成引用【来源:" + source.ID + "】"}); err != nil {
			t.Fatal(err)
		}
		brancher := f.store.(CloudBranchStore)
		branch, _, err := brancher.CreateCloudBranch(ctx, 7, run.ConversationID, CloudBranchInput{ClientRequestID: "source-branch", MessageID: run.AssistantMessageID, Action: "fork"})
		if err != nil {
			t.Fatal(err)
		}
		if err = f.store.DeleteCloudConversation(ctx, 7, run.ConversationID); err != nil {
			t.Fatal(err)
		}
		if _, err = sources.GetCloudResearchSource(ctx, 7, source.ID); err != nil {
			t.Fatal("branch lost a retained source after original deletion")
		}
		messages, err := f.store.ListCloudMessages(ctx, 7, branch.Conversation.ID)
		if err != nil || len(messages) != 2 || !strings.Contains(string(messages[1].Content), source.ID) {
			t.Fatal("branch did not preserve its source citation")
		}
		if err = sources.DeleteCloudResearchSource(ctx, 8, source.ID, source.Version); !errors.Is(err, ErrNotFound) {
			t.Fatal("foreign source deletion accepted")
		}
		if err = sources.DeleteCloudResearchSource(ctx, 7, source.ID, source.Version+1); !errors.Is(err, ErrCloudResearchSourceConflict) {
			t.Fatal("stale source deletion accepted")
		}
		if err = sources.DeleteCloudResearchSource(ctx, 7, source.ID, source.Version); err != nil {
			t.Fatal(err)
		}
		if err = sources.DeleteCloudResearchSource(ctx, 7, source.ID, source.Version); err != nil {
			t.Fatal("duplicate deletion failed")
		}
		if _, err = sources.GetCloudResearchSource(ctx, 7, source.ID); !errors.Is(err, ErrNotFound) {
			t.Fatal("deleted source readable")
		}
		if available, err := sources.CloudResearchSourceAvailable(ctx, 7, source.ID); err != nil || available {
			t.Fatal("deleted source head remained available")
		}
		if _, err = sources.GetCloudResearchSourcesForOperation(ctx, 7, op.ID); !errors.Is(err, ErrNotFound) {
			t.Fatal("deleted source resurrected by operation receipt")
		}
	})
	t.Run("empty search receipt is not an unknown search", func(t *testing.T) {
		f := researchFixture(t, postgres)
		sources := f.store.(CloudResearchSourceStore)
		run := toolRunningRun(t, f, 7, "")
		op := researchOperation(t, f, run, "web_search", "round:0:call:0", true)
		if _, err := sources.ReserveCloudResearchSearch(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, op.ID, 1); err != nil {
			t.Fatal(err)
		}
		if result, err := sources.PersistCloudResearchSources(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, op.ID, nil); err != nil || len(result) != 0 {
			t.Fatal("empty result did not persist")
		}
		if result, err := sources.GetCloudResearchSourcesForOperation(ctx, 7, op.ID); err != nil || result == nil || len(result) != 0 {
			t.Fatal("empty result receipt was lost")
		}
	})
	t.Run("different runs share one atomic account budget and cancellation blocks publication", func(t *testing.T) {
		f := researchFixture(t, postgres)
		sources := f.store.(CloudResearchSourceStore)
		first, second := toolRunningRun(t, f, 7, ""), toolRunningRun(t, f, 7, "")
		firstOp, secondOp := researchOperation(t, f, first, "web_search", "round:0:call:0", true), researchOperation(t, f, second, "web_search", "round:0:call:0", true)
		var wg sync.WaitGroup
		results := make(chan error, 2)
		for _, pair := range []struct {
			run *CloudRun
			op  *CloudToolOperation
		}{{first, firstOp}, {second, secondOp}} {
			wg.Add(1)
			go func(run *CloudRun, op *CloudToolOperation) {
				defer wg.Done()
				created, err := sources.ReserveCloudResearchSearch(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, op.ID, 1)
				if err == nil && !created {
					err = ErrCloudResearchSourceInvalid
				}
				results <- err
			}(pair.run, pair.op)
		}
		wg.Wait()
		close(results)
		accepted, rejected := 0, 0
		for err := range results {
			if err == nil {
				accepted++
			} else if errors.Is(err, ErrCloudResearchSourceQuota) {
				rejected++
			} else {
				t.Fatal(err)
			}
		}
		if accepted != 1 || rejected != 1 {
			t.Fatal("account budget raced across Run row locks")
		}
		if _, err := f.runs.CancelCloudRun(ctx, 7, first.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := sources.PersistCloudResearchSources(ctx, 7, first.ID, first.LeaseOwner, first.Attempt, firstOp.ID, []CloudResearchSourceInput{researchSnippet()}); !errors.Is(err, ErrCloudRunLeaseLost) {
			t.Fatal("cancelling run published a new source")
		}
	})
}

type failedResearchViewerStore struct {
	Store
	CloudResearchSourceStore
}

func (s failedResearchViewerStore) GetCloudResearchSource(context.Context, int64, string) (*CloudResearchSource, error) {
	return nil, errors.New("synthetic-private-database-detail")
}

func TestCloudResearchSourceSecretsValidationAndHTTP(t *testing.T) {
	ctx := context.Background()
	f := researchFixture(t, false)
	sources := f.store.(CloudResearchSourceStore)
	run := toolRunningRun(t, f, 7, "")
	op := researchOperation(t, f, run, "fetch_page", "round:0:call:0", true)
	usa := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("source viewer made an upstream request")
		w.WriteHeader(500)
	}))
	defer usa.Close()
	service := NewService(f.store, NewUSAClientWithHTTPClient(usa.URL, usa.Client()), time.Hour, time.Hour)
	secretInput := researchPage()
	secretInput.Text = "synthetic-private-token"
	secretInput.SHA256 = cloudResearchDigest(secretInput.Text)
	if _, err := service.PersistCloudResearchSources(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, op.ID, []CloudResearchSourceInput{secretInput}, "synthetic-private-token"); err == nil {
		t.Fatal("private upstream reflection was persisted")
	}
	for _, input := range []CloudResearchSourceInput{{Kind: CloudResearchPage, URL: "http://127.0.0.1/"}, {Kind: CloudResearchSearchSnippet, URL: "https://example.com/", Text: "fake body", ObservedAt: time.Now()}} {
		if _, _, err := prepareCloudResearchInputs([]CloudResearchSourceInput{input}, time.Now()); err == nil {
			t.Fatal("forged/unsafe source accepted")
		}
	}
	published, err := service.PersistCloudResearchSources(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, op.ID, []CloudResearchSourceInput{researchPage()})
	if err != nil {
		t.Fatal(err)
	}
	source := published[0]
	searchOp := researchOperation(t, f, run, "web_search", "round:0:call:1", true)
	if _, err = sources.ReserveCloudResearchSearch(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, searchOp.ID, 1); err != nil {
		t.Fatal(err)
	}
	_, err = sources.PersistCloudResearchSources(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, searchOp.ID, []CloudResearchSourceInput{researchSnippet()})
	if err != nil {
		t.Fatal(err)
	}
	for _, session := range []*Session{{ID: "research-owner", UserID: 7, AccessToken: "synthetic-token", AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)}, {ID: "research-other", UserID: 8, AccessToken: "synthetic-other", AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)}} {
		if err = f.store.PutSession(ctx, session); err != nil {
			t.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	NewHTTPHandler(service, false).registerCloudResearchSources(mux)
	request := func(method, path, cookie string) (int, string) {
		t.Helper()
		req := httptest.NewRequest(method, path, nil)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: cookie})
		}
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, req)
		return recorder.Code, recorder.Body.String()
	}
	path := "/api/web-chat/sources/" + source.ID
	status, body := request("GET", path, "research-owner")
	if status != 200 || !strings.Contains(body, source.FinalURL) || strings.Contains(body, "第一行合成资料") || strings.Contains(body, op.ID) {
		t.Fatal("expected the original link without the page body or private operation")
	}
	if status, _ = request("GET", path, "research-other"); status != 404 {
		t.Fatal("foreign source was readable")
	}
	if status, _ = request("GET", path, ""); status != 401 {
		t.Fatal("unauthenticated source read accepted")
	}
	for _, retired := range []string{path + "/content", "/api/web-chat/sources?conversation_id=" + source.ConversationID} {
		if status, _ = request("GET", retired, "research-owner"); status != 404 {
			t.Fatalf("retired source route %s returned %d", retired, status)
		}
	}
	if status, _ = request("DELETE", path, "research-owner"); status != 405 {
		t.Fatal("source metadata route accepted deletion")
	}
	faulty := failedResearchViewerStore{Store: f.store, CloudResearchSourceStore: sources}
	faultMux := http.NewServeMux()
	NewHTTPHandler(NewService(faulty, service.usa, time.Hour, time.Hour), false).registerCloudResearchSources(faultMux)
	faultRequest := httptest.NewRequest("GET", "/api/web-chat/sources/"+source.ID, nil)
	faultRequest.AddCookie(&http.Cookie{Name: SessionCookieName, Value: "research-owner"})
	faultResponse := httptest.NewRecorder()
	faultMux.ServeHTTP(faultResponse, faultRequest)
	if faultResponse.Code != 503 || strings.Contains(faultResponse.Body.String(), "synthetic-private-database-detail") {
		t.Fatal("storage fault leaked private infrastructure detail")
	}
}
