package account

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

const cloudRunLease = 30 * time.Second

type CreateCloudRunInput struct {
	ConversationID  string                  `json:"conversation_id"`
	ClientRequestID string                  `json:"client_request_id"`
	Model           string                  `json:"model"`
	Content         json.RawMessage         `json:"content"`
	ReasoningEffort string                  `json:"reasoning_effort,omitempty"`
	ProviderKeyID   int64                   `json:"provider_key_id,omitempty"`
	ModelParameters CloudRunModelParameters `json:"model_parameters,omitempty"`
	PublicResearch  *CloudRunPublicResearch `json:"public_research,omitempty"`
}

type cloudRunRuntime struct {
	service  *Service
	store    CloudRunStore
	sessions cloudRunSessionStore
	ctx      context.Context
	cancel   context.CancelFunc
	wake     chan struct{}
	wg       sync.WaitGroup
	mu       sync.Mutex
	active   map[string]context.CancelFunc
	config   CloudRuntimeConfig
}

func (s *Service) StartCloudRuns(parent context.Context) error {
	s.cloudRuntimeMu.Lock()
	defer s.cloudRuntimeMu.Unlock()
	if s.cloudRuntime != nil {
		return nil
	}
	config, err := normalizeCloudRuntimeConfig(s.cloudRuntimeConfig)
	if err != nil {
		return err
	}
	store, ok := s.store.(CloudRunStore)
	if !ok {
		return &APIError{Status: http.StatusServiceUnavailable, Message: "cloud task storage is unavailable"}
	}
	if config.AdmissionConfigured {
		admission, ok := s.store.(CloudRunAdmissionStore)
		if !ok {
			return &APIError{Status: http.StatusServiceUnavailable, Message: "cloud task admission policy storage is unavailable"}
		}
		policyCtx, cancel := context.WithTimeout(parent, 5*time.Second)
		err := admission.ConfigureCloudRunAdmission(policyCtx, CloudRunAdmissionLimits{MaxExecutingPerAccount: config.MaxExecutingPerAccount, MaxQueuedPerAccount: config.MaxQueuedPerAccount})
		cancel()
		if err != nil {
			return err
		}
	}
	sessions, ok := s.store.(cloudRunSessionStore)
	if !ok {
		return &APIError{Status: http.StatusServiceUnavailable, Message: "cloud task authorization is unavailable"}
	}
	ctx, cancel := context.WithCancel(parent)
	runtime := &cloudRunRuntime{service: s, store: store, sessions: sessions, ctx: ctx, cancel: cancel, wake: make(chan struct{}, 1), active: make(map[string]context.CancelFunc), config: config}
	s.cloudRuntime = runtime
	for i := 0; i < config.WorkerCount; i++ {
		runtime.wg.Add(1)
		go runtime.worker(uuid.NewString())
	}
	runtime.wg.Add(1)
	go runtime.cleanupWorker()
	return nil
}

func (s *Service) CloseCloudRuns() {
	s.cloudRuntimeMu.Lock()
	runtime := s.cloudRuntime
	s.cloudRuntimeMu.Unlock()
	if runtime != nil {
		runtime.cancel()
		runtime.wg.Wait()
	}
}

func (s *Service) signalCloudRun(id string) {
	s.cloudRuntimeMu.Lock()
	runtime := s.cloudRuntime
	s.cloudRuntimeMu.Unlock()
	if runtime == nil {
		return
	}
	if id != "" {
		runtime.mu.Lock()
		cancel := runtime.active[id]
		runtime.mu.Unlock()
		if cancel != nil {
			cancel()
		}
	}
	select {
	case runtime.wake <- struct{}{}:
	default:
	}
}

func validateCloudContent(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 || len(raw) > CloudRunMaxInputBytes || !utf8.Valid(raw) {
		return nil, ErrCloudRunInvalid
	}
	var content any
	if err := json.Unmarshal(raw, &content); err != nil {
		return nil, ErrCloudRunInvalid
	}
	switch value := content.(type) {
	case string:
		if strings.TrimSpace(value) == "" {
			return nil, ErrCloudRunInvalid
		}
	case []any:
		if len(value) == 0 || len(value) > 32 {
			return nil, ErrCloudRunInvalid
		}
		references := 0
		for index, item := range value {
			part, ok := item.(map[string]any)
			if !ok {
				return nil, ErrCloudRunInvalid
			}
			switch part["type"] {
			case "text", "image_url":
				clean, ok := cloudTextImagePart(part, true)
				if !ok {
					return nil, ErrCloudRunInvalid
				}
				value[index] = clean
			case "file_reference":
				references++
				if references > 8 {
					return nil, ErrCloudRunInvalid
				}
				fileID, ok := part["file_id"].(string)
				if !ok {
					return nil, ErrCloudRunInvalid
				}
				parsed, err := uuid.Parse(fileID)
				if err != nil {
					return nil, ErrCloudRunInvalid
				}
				// Names and source bytes are resolved through owned server records.
				part["file_id"] = parsed.String()
			case "artifact_reference":
				references++
				if references > 8 {
					return nil, ErrCloudRunInvalid
				}
				versionID, ok := part["version_id"].(string)
				if !ok {
					return nil, ErrCloudRunInvalid
				}
				parsed, err := uuid.Parse(versionID)
				if err != nil {
					return nil, ErrCloudRunInvalid
				}
				part["version_id"] = parsed.String()
			default:
				return nil, ErrCloudRunInvalid
			}
		}
	default:
		return nil, ErrCloudRunInvalid
	}
	return json.Marshal(content)
}

func (s *Service) CreateCloudRun(ctx context.Context, session *Session, input CreateCloudRunInput) (*CloudRun, bool, error) {
	if session == nil || session.UserID <= 0 || !session.SessionExpiresAt.After(s.now()) {
		return nil, false, &APIError{Status: http.StatusUnauthorized, Message: "account login required"}
	}
	current, err := s.Session(ctx, session.ID)
	if err != nil {
		return nil, false, err
	}
	if current.UserID != session.UserID {
		return nil, false, sessionMissingError()
	}
	session = current
	input.ConversationID = strings.TrimSpace(input.ConversationID)
	input.ClientRequestID = strings.TrimSpace(input.ClientRequestID)
	input.Model = strings.TrimSpace(input.Model)
	if input.Model == "" {
		input.Model = "gpt-5.1"
	}
	if len(input.Model) > 200 || input.ProviderKeyID < 0 || len(input.ClientRequestID) == 0 || len(input.ClientRequestID) > 128 {
		return nil, false, ErrCloudRunInvalid
	}
	conversationID, err := uuid.Parse(input.ConversationID)
	if err != nil {
		return nil, false, ErrCloudRunInvalid
	}
	input.ConversationID = conversationID.String()
	if !validCloudReasoningEffort(input.ReasoningEffort) {
		return nil, false, ErrCloudRunInvalid
	}
	parameters, err := normalizeCloudModelParameters(input.ModelParameters)
	if err != nil {
		return nil, false, err
	}
	input.ModelParameters = parameters
	publicResearch, err := normalizeCloudPublicResearch(input.PublicResearch)
	if err != nil {
		return nil, false, err
	}
	input.PublicResearch = publicResearch
	content, err := validateCloudContent(input.Content)
	if err != nil {
		return nil, false, err
	}
	input.Content = content
	if !cloudAllowsImage(parameters) && cloudContainsImage(content) {
		return nil, false, cloudParameterError("model_input_modality_unsupported", "the selected model configuration does not allow image input")
	}
	logical, err := logicalCloudRunContent(content)
	if err != nil {
		return nil, false, err
	}
	input.Content = logical
	hash, err := cloudRunLogicalRequestHash(input)
	if err != nil {
		return nil, false, err
	}
	if previous, err := s.replayCloudRun(ctx, session, input, hash); err == nil {
		return previous, false, nil
	} else if !errors.Is(err, ErrNotFound) {
		return nil, false, err
	}
	if _, err := s.store.GetCloudConversation(ctx, session.UserID, input.ConversationID); err != nil {
		return s.replayCloudRunAfterValidationFailure(ctx, session, input, hash, err)
	}
	content, err = s.canonicalCloudFileReferences(ctx, session.UserID, logical)
	if err != nil {
		return s.replayCloudRunAfterValidationFailure(ctx, session, input, hash, err)
	}
	// Validate the selected account-owned key before accepting a user message.
	if input.ProviderKeyID > 0 {
		_, err = s.WebAPIKeyForID(ctx, session, input.ProviderKeyID)
	} else {
		_, err = s.WebAPIKey(ctx, session)
	}
	if err != nil {
		return s.replayCloudRunAfterValidationFailure(ctx, session, input, hash, err)
	}
	sessions, ok := s.store.(cloudRunSessionStore)
	if !ok {
		return nil, false, ErrCloudRunInvalid
	}
	ref, err := sessions.BindCloudRunSession(ctx, session)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			err = sessionMissingError()
		}
		return s.replayCloudRunAfterValidationFailure(ctx, session, input, hash, err)
	}
	store, ok := s.store.(CloudRunStore)
	if !ok {
		return nil, false, ErrCloudRunInvalid
	}
	run, created, err := store.CreateCloudRun(ctx, &CloudRun{ConversationID: input.ConversationID, UserID: session.UserID, SessionRef: ref, ClientRequestID: input.ClientRequestID, RequestHash: hash, Model: input.Model, ReasoningEffort: input.ReasoningEffort, ProviderKeyID: input.ProviderKeyID, ModelParameters: parameters, PublicResearch: publicResearch, RequestContent: content})
	if err != nil {
		return nil, false, err
	}
	if err = s.StartCloudRuns(context.Background()); err != nil {
		return run, created, err
	}
	s.signalCloudRun("")
	return run, created, nil
}

func (r *cloudRunRuntime) worker(owner string) {
	defer r.wg.Done()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		if r.ctx.Err() != nil {
			return
		}
		ctx, cancel := context.WithTimeout(r.ctx, 5*time.Second)
		_, recoverErr := r.store.InterruptExpiredCloudRuns(ctx)
		var run *CloudRun
		var err error
		if recoverErr == nil {
			run, err = r.store.ClaimCloudRun(ctx, owner, cloudRunLease)
		}
		cancel()
		if run != nil && err == nil {
			r.execute(run, owner)
			continue
		}
		select {
		case <-r.ctx.Done():
			return
		case <-r.wake:
		case <-ticker.C:
		}
	}
}

func (r *cloudRunRuntime) execute(run *CloudRun, owner string) {
	ctx, cancel := context.WithTimeout(r.ctx, r.config.RunTimeout)
	r.mu.Lock()
	r.active[run.ID] = cancel
	r.mu.Unlock()
	defer func() { cancel(); r.mu.Lock(); delete(r.active, run.ID); r.mu.Unlock() }()
	stopHeartbeat := make(chan struct{})
	var heartbeat sync.WaitGroup
	heartbeat.Add(1)
	go func() {
		defer heartbeat.Done()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-stopHeartbeat:
				return
			case <-ticker.C:
				check, done := context.WithTimeout(ctx, 3*time.Second)
				current, err := r.store.RenewCloudRunLease(check, run.UserID, run.ID, owner, run.Attempt, cloudRunLease)
				session, sessionErr := r.sessions.GetCloudRunSession(check, run.SessionRef)
				done()
				if err != nil || current.State == CloudRunCancelling || sessionErr != nil || session.UserID != run.UserID {
					cancel()
					return
				}
			}
		}
	}()
	facts := &cloudRunExecutionFacts{}
	state, code := r.generate(ctx, run, owner, facts)
	close(stopHeartbeat)
	heartbeat.Wait()
	finishCtx, finishCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer finishCancel()
	current, err := r.store.GetCloudRun(finishCtx, run.UserID, run.ID)
	if err != nil || current.Terminal() {
		return
	}
	if current.State == CloudRunCancelling {
		state, code = r.cancelledOutcome(finishCtx, run, facts)
	} else if ctx.Err() != nil {
		state, code = CloudRunInterrupted, "execution_interrupted"
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			code = "execution_timeout"
		}
	}
	payload := map[string]any{"state": state, "error_code": code}
	if code == cloudCancellationOutcomeUnknown {
		payload["message"] = cloudCancellationOutcomeNotice
	}
	_, err = r.store.CommitCloudRun(finishCtx, run.UserID, run.ID, owner, run.Attempt, CloudRunCommit{OperationID: "terminal-" + uuid.NewString(), State: state, ErrorCode: code, EventType: "run." + state, Payload: cloudJSON(payload)})
	if err != nil && !errors.Is(err, ErrCloudRunLeaseLost) && !errors.Is(err, ErrNotFound) {
		slog.Warn("cloud task terminal persistence failed", "run_id", run.ID)
	}
}

func cloudJSON(value any) json.RawMessage { data, _ := json.Marshal(value); return data }

func (r *cloudRunRuntime) generate(ctx context.Context, run *CloudRun, owner string, facts *cloudRunExecutionFacts) (string, string) {
	return r.generateWithTools(ctx, run, owner, facts)
}

type cloudStreamFrame struct {
	data string
	err  error
	eof  bool
}

func readCloudStream(ctx context.Context, body io.Reader, out chan<- cloudStreamFrame) {
	send := func(frame cloudStreamFrame) bool {
		select {
		case out <- frame:
			return true
		case <-ctx.Done():
			return false
		}
	}
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 4096), CloudRunMaxEventBytes)
	var data strings.Builder
	flush := func() bool {
		if data.Len() == 0 {
			return true
		}
		value := strings.TrimSuffix(data.String(), "\n")
		data.Reset()
		return send(cloudStreamFrame{data: value})
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if !flush() {
				return
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			value := strings.TrimPrefix(line, "data:")
			value = strings.TrimPrefix(value, " ")
			if data.Len()+len(value)+1 > CloudRunMaxEventBytes {
				send(cloudStreamFrame{err: ErrCloudRunLimit})
				return
			}
			data.WriteString(value)
			data.WriteByte('\n')
		}
	}
	if !flush() {
		return
	}
	send(cloudStreamFrame{err: scanner.Err(), eof: true})
}

type cloudSecretFilter struct {
	secrets []string
	tail    string
}

func newCloudSecretFilter(values ...string) *cloudSecretFilter {
	filter := &cloudSecretFilter{}
	for _, value := range values {
		if value != "" {
			filter.secrets = append(filter.secrets, value)
		}
	}
	sort.Slice(filter.secrets, func(i, j int) bool { return len(filter.secrets[i]) > len(filter.secrets[j]) })
	return filter
}
func (f *cloudSecretFilter) write(text string) string {
	text = f.tail + text
	for _, secret := range f.secrets {
		text = strings.ReplaceAll(text, secret, "[redacted]")
	}
	keep := 0
	for _, secret := range f.secrets {
		max := len(secret) - 1
		if max > len(text) {
			max = len(text)
		}
		for n := max; n > keep; n-- {
			if strings.HasSuffix(text, secret[:n]) {
				keep = n
				break
			}
		}
	}
	f.tail = text[len(text)-keep:]
	return text[:len(text)-keep]
}
func (f *cloudSecretFilter) finish() string { value := f.tail; f.tail = ""; return value }

func cloudNumericUsage(raw json.RawMessage) json.RawMessage {
	var values map[string]json.RawMessage
	if json.Unmarshal(raw, &values) != nil {
		return nil
	}
	clean := make(map[string]any)
	for _, key := range []string{"prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens"} {
		var value int64
		if part, ok := values[key]; ok && json.Unmarshal(part, &value) == nil && value >= 0 {
			clean[key] = value
		}
	}
	if len(clean) == 0 {
		return nil
	}
	return cloudJSON(clean)
}

func cloudRunAPIError(err error) error {
	if errors.Is(err, ErrCloudRunQueueFull) {
		return &APIError{Status: http.StatusTooManyRequests, Reason: "account_queue_full", Message: "当前账户排队任务已达上限，请等待已有任务完成或取消后再试。"}
	}
	if errors.Is(err, ErrNotFound) {
		return &APIError{Status: http.StatusNotFound, Message: "cloud task or conversation not found"}
	}
	if errors.Is(err, ErrCloudRunConflict) {
		return &APIError{Status: http.StatusConflict, Message: "request ID was already used for different content", Reason: "request_conflict"}
	}
	if errors.Is(err, ErrCloudRunBusy) {
		return &APIError{Status: http.StatusConflict, Message: "this conversation already has an active task", Reason: "run_active"}
	}
	if errors.Is(err, ErrCloudRunInvalid) {
		return &APIError{Status: http.StatusBadRequest, Message: "invalid cloud task request"}
	}
	if errors.Is(err, ErrCloudRunLimit) {
		return &APIError{Status: http.StatusRequestEntityTooLarge, Message: "cloud task size limit exceeded"}
	}
	return err
}
