// Package cloudexecutor is the authenticated loopback client for the official
// E2B SDK adapter. It does not implement an Agent loop or authorize user tools.
package cloudexecutor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	StateExecuting = "executing"
	StateSucceeded = "succeeded"
	StateFailed    = "failed"
	StateCancelled = "cancelled"
	StateUnknown   = "unknown"
)

type Scope struct {
	OwnerScope   string `json:"owner_scope"`
	WorkspaceRef string `json:"workspace_ref"`
}

type Operation struct {
	OperationID  string         `json:"operation_id"`
	OwnerScope   string         `json:"owner_scope"`
	WorkspaceRef string         `json:"workspace_ref"`
	Action       string         `json:"action"`
	SandboxID    string         `json:"sandbox_id,omitempty"`
	Input        map[string]any `json:"input,omitempty"`
}

func (o Operation) Scope() Scope {
	return Scope{OwnerScope: o.OwnerScope, WorkspaceRef: o.WorkspaceRef}
}

type ReceiptError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Receipt struct {
	OperationID string          `json:"operation_id"`
	Action      string          `json:"action"`
	State       string          `json:"state"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
	Result      json.RawMessage `json:"result,omitempty"`
	Error       *ReceiptError   `json:"error,omitempty"`
}

func (r Receipt) Terminal() bool { return r.State != "" && r.State != StateExecuting }

type Health struct {
	Service        string         `json:"service"`
	Protocol       int            `json:"protocol"`
	Enabled        bool           `json:"enabled"`
	DisabledReason string         `json:"disabled_reason,omitempty"`
	Journal        *JournalHealth `json:"journal,omitempty"`
	Limits         struct {
		MaxConcurrent  int `json:"max_concurrent"`
		MaxTimeoutMS   int `json:"max_timeout_ms"`
		MaxInputBytes  int `json:"max_input_bytes"`
		MaxOutputBytes int `json:"max_output_bytes"`
		MaxFileBytes   int `json:"max_file_bytes"`
	} `json:"limits"`
}

type JournalHealth struct {
	Records            int64 `json:"records"`
	ResultBytes        int64 `json:"result_bytes"`
	MaxRecords         int64 `json:"max_records"`
	MaxResultBytes     int64 `json:"max_result_bytes"`
	AdmissionAvailable *bool `json:"admission_available"`
}

type Config struct {
	BaseURL          string
	Token            string
	RequestTimeout   time.Duration
	PollInterval     time.Duration
	CancelTimeout    time.Duration
	MaxWait          time.Duration
	MaxResponseBytes int64
	MaxRequestBytes  int64
}

type Client struct {
	baseURL string
	token   string
	http    *http.Client
	config  Config
	runner  func(context.Context, Operation) (Receipt, error)
}

// WithOperationRunner returns an immutable client view whose Execute-based
// helpers use a caller-owned durable operation ledger. The runner can call
// Execute on the original client; it must not call the returned view recursively.
func (c *Client) WithOperationRunner(runner func(context.Context, Operation) (Receipt, error)) *Client {
	copy := *c
	copy.runner = runner
	return &copy
}

// APIError deliberately excludes response messages, request bodies, headers,
// URLs, and SDK error details. Code is restricted to a known protocol vocabulary.
type APIError struct {
	Status          int
	Code            string
	MayHaveExecuted bool
}

func (e *APIError) Error() string {
	return fmt.Sprintf("cloud executor request failed (status=%d code=%s)", e.Status, e.Code)
}

// UnknownOutcomeError means the original operation must be reconciled by ID.
// A new operation ID must never be generated automatically to retry its effect.
type UnknownOutcomeError struct {
	Receipt Receipt
	Cause   error
}

func (e *UnknownOutcomeError) Error() string {
	return "cloud executor operation outcome is unknown; reconcile the original operation ID"
}
func (e *UnknownOutcomeError) Unwrap() error { return e.Cause }

var identifierPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$`)
var tokenPattern = regexp.MustCompile(`^[a-zA-Z0-9_+/.=-]{32,512}$`)

func New(config Config) (*Client, error) {
	parsed, err := url.Parse(config.BaseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return nil, errors.New("cloud executor base URL must be a plain loopback HTTP origin")
	}
	address, err := netip.ParseAddr(parsed.Hostname())
	if err != nil || !address.IsLoopback() || parsed.Port() == "" {
		return nil, errors.New("cloud executor base URL must use a literal loopback address and explicit port")
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port < 1 || port > 65535 {
		return nil, errors.New("cloud executor base URL port is invalid")
	}
	if !tokenPattern.MatchString(config.Token) {
		return nil, errors.New("cloud executor requires an explicit strong internal token")
	}
	if config.RequestTimeout <= 0 {
		config.RequestTimeout = 10 * time.Second
	}
	if config.PollInterval <= 0 {
		config.PollInterval = 250 * time.Millisecond
	}
	if config.CancelTimeout <= 0 {
		config.CancelTimeout = 20 * time.Second
	}
	if config.MaxWait <= 0 {
		config.MaxWait = 170 * time.Second
	}
	if config.MaxResponseBytes <= 0 {
		config.MaxResponseBytes = 2_000_000
	}
	if config.MaxRequestBytes <= 0 {
		config.MaxRequestBytes = 1_500_000
	}
	if config.RequestTimeout > 30*time.Second || config.CancelTimeout > 60*time.Second || config.MaxWait > 10*time.Minute ||
		config.PollInterval < time.Millisecond || config.PollInterval > 5*time.Second || config.MaxResponseBytes > 2_000_000 || config.MaxRequestBytes > 1_500_000 {
		return nil, errors.New("cloud executor client limits exceed protocol bounds")
	}
	transport := &http.Transport{
		Proxy: nil, DialContext: (&net.Dialer{Timeout: config.RequestTimeout, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2: true, MaxIdleConns: 8, MaxIdleConnsPerHost: 8, MaxConnsPerHost: 16,
		IdleConnTimeout: 30 * time.Second, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: config.RequestTimeout,
		MaxResponseHeaderBytes: 8192,
	}
	return &Client{baseURL: strings.TrimRight(config.BaseURL, "/"), token: config.Token, config: config, http: &http.Client{
		Transport: transport, Timeout: config.RequestTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

func (c *Client) CloseIdleConnections() { c.http.CloseIdleConnections() }

func (c *Client) Health(ctx context.Context) (Health, error) {
	var health Health
	if err := c.request(ctx, http.MethodGet, "/v1/health", nil, &health); err != nil {
		return Health{}, err
	}
	if health.Service != "zeroagent-cloud-executor" || health.Protocol != 1 {
		return Health{}, &APIError{Code: "invalid_protocol"}
	}
	return health, nil
}

func validScope(scope Scope) bool {
	return identifierPattern.MatchString(scope.OwnerScope) && identifierPattern.MatchString(scope.WorkspaceRef)
}

func (c *Client) Submit(ctx context.Context, operation Operation) (Receipt, error) {
	if !validScope(operation.Scope()) || !identifierPattern.MatchString(operation.OperationID) {
		return Receipt{}, &APIError{Code: "invalid_identifier"}
	}
	var receipt Receipt
	if err := c.request(ctx, http.MethodPost, "/v1/operations", operation, &receipt); err != nil {
		return Receipt{}, err
	}
	if err := c.validateReceipt(&receipt, operation.OperationID); err != nil {
		err.(*APIError).MayHaveExecuted = true
		return Receipt{}, err
	}
	if receipt.Action != operation.Action {
		return Receipt{}, &APIError{Code: "invalid_receipt", MayHaveExecuted: true}
	}
	return receipt, nil
}

func (c *Client) Get(ctx context.Context, operationID string, scope Scope) (Receipt, error) {
	if !validScope(scope) || !identifierPattern.MatchString(operationID) {
		return Receipt{}, &APIError{Code: "invalid_identifier"}
	}
	query := url.Values{"owner_scope": {scope.OwnerScope}, "workspace_ref": {scope.WorkspaceRef}}
	var receipt Receipt
	err := c.request(ctx, http.MethodGet, "/v1/operations/"+url.PathEscape(operationID)+"?"+query.Encode(), nil, &receipt)
	if err != nil {
		return Receipt{}, err
	}
	if err := c.validateReceipt(&receipt, operationID); err != nil {
		return Receipt{}, err
	}
	return receipt, nil
}

func (c *Client) Cancel(ctx context.Context, operationID string, scope Scope) (Receipt, error) {
	if !validScope(scope) || !identifierPattern.MatchString(operationID) {
		return Receipt{}, &APIError{Code: "invalid_identifier"}
	}
	var receipt Receipt
	if err := c.request(ctx, http.MethodPost, "/v1/operations/"+url.PathEscape(operationID)+"/cancel", scope, &receipt); err != nil {
		return Receipt{}, err
	}
	if err := c.validateReceipt(&receipt, operationID); err != nil {
		return Receipt{}, err
	}
	return receipt, nil
}

// Acknowledge retires a known terminal result only after its caller has saved
// the required facts durably. The adapter retains identity/scope/hash forever;
// acknowledgement never grants permission to execute the operation again.
func (c *Client) Acknowledge(ctx context.Context, operationID string, scope Scope) error {
	if !validScope(scope) || !identifierPattern.MatchString(operationID) {
		return &APIError{Code: "invalid_identifier"}
	}
	var result struct {
		OperationID  string `json:"operation_id"`
		Acknowledged bool   `json:"acknowledged"`
	}
	if err := c.request(ctx, http.MethodPost, "/v1/operations/"+url.PathEscape(operationID)+"/acknowledge", scope, &result); err != nil {
		return err
	}
	if result.OperationID != operationID || !result.Acknowledged {
		return &APIError{Code: "invalid_receipt", MayHaveExecuted: true}
	}
	return nil
}

// Execute submits exactly once, polls its stable ID, and explicitly requests
// remote cancellation if the caller stops waiting. It never starts a new ID or
// assumes that an HTTP interruption means that E2B stopped.
func (c *Client) Execute(ctx context.Context, operation Operation) (Receipt, error) {
	if c.runner != nil {
		return c.runner(ctx, operation)
	}
	if err := ctx.Err(); err != nil {
		return Receipt{}, err
	}
	waitCtx, cancel := context.WithTimeout(ctx, c.config.MaxWait)
	defer cancel()
	receipt, err := c.Submit(waitCtx, operation)
	if err != nil {
		// A definitive API rejection did not accept the operation. A transport or
		// response failure may have happened after acceptance, so reconcile by ID.
		var apiError *APIError
		if errors.As(err, &apiError) && !apiError.MayHaveExecuted {
			return Receipt{}, err
		}
		unknown := Receipt{OperationID: operation.OperationID, Action: operation.Action, State: StateUnknown}
		return c.reconcileInterrupted(ctx, operation, unknown, err)
	}
	for {
		if receipt.Terminal() {
			return terminal(receipt)
		}
		if err := waitTick(waitCtx, c.config.PollInterval); err != nil {
			return c.reconcileInterrupted(ctx, operation, receipt, err)
		}
		next, err := c.Get(waitCtx, operation.OperationID, operation.Scope())
		if err != nil {
			return c.reconcileInterrupted(ctx, operation, receipt, err)
		}
		receipt = next
	}
}

func terminal(receipt Receipt) (Receipt, error) {
	if receipt.State == StateUnknown {
		return receipt, &UnknownOutcomeError{Receipt: receipt}
	}
	// failed/cancelled are recorded tool outcomes, not request transport errors.
	return receipt, nil
}

func (c *Client) reconcileInterrupted(original context.Context, operation Operation, last Receipt, cause error) (Receipt, error) {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(original), c.config.CancelTimeout)
	defer cancel()
	// Even an interrupted submission may already be running; a cancel request
	// is safer than treating the missing response as a failed submission.
	next, err := c.Cancel(cleanupCtx, operation.OperationID, operation.Scope())
	if err != nil {
		last.State = StateUnknown
		return last, &UnknownOutcomeError{Receipt: last, Cause: cause}
	}
	last = next
	for {
		if last.Terminal() {
			return terminal(last)
		}
		if err := waitTick(cleanupCtx, c.config.PollInterval); err != nil {
			break
		}
		next, err := c.Get(cleanupCtx, operation.OperationID, operation.Scope())
		if err != nil {
			break
		}
		last = next
	}
	last.State = StateUnknown
	return last, &UnknownOutcomeError{Receipt: last, Cause: cause}
}

func waitTick(ctx context.Context, interval time.Duration) error {
	timer := time.NewTimer(interval)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (c *Client) request(ctx context.Context, method, path string, input, output any) error {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return &APIError{Code: "invalid_request"}
		}
		if int64(len(encoded)) > c.config.MaxRequestBytes {
			return &APIError{Code: "body_limit"}
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return &APIError{Code: "invalid_request"}
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
		// The default Transport can replay a buffered POST on a stale reused
		// connection if GetBody is present. Do not let it replay effects.
		request.GetBody = nil
	}
	response, err := c.http.Do(request)
	if err != nil {
		return &APIError{Code: "transport_failure", MayHaveExecuted: true}
	}
	defer func() { _ = response.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(response.Body, c.config.MaxResponseBytes+1))
	if err != nil {
		return &APIError{Code: "response_failure", MayHaveExecuted: true}
	}
	if int64(len(data)) > c.config.MaxResponseBytes {
		return &APIError{Code: "response_limit", MayHaveExecuted: true}
	}
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusAccepted {
		var envelope struct {
			Error ReceiptError `json:"error"`
		}
		_ = json.Unmarshal(data, &envelope)
		return &APIError{Status: response.StatusCode, Code: safeCode(envelope.Error.Code), MayHaveExecuted: response.StatusCode >= 500 || response.StatusCode < 400 || response.StatusCode == http.StatusGone}
	}
	if response.Header.Get("Content-Type") != "application/json" && !strings.HasPrefix(response.Header.Get("Content-Type"), "application/json;") {
		return &APIError{Code: "invalid_response", MayHaveExecuted: true}
	}
	// Exact configured management token must not escape even if a compromised
	// local service accidentally reflects it in a tool result.
	data = bytes.ReplaceAll(data, []byte(c.token), []byte("[redacted]"))
	if err := json.Unmarshal(data, output); err != nil {
		return &APIError{Code: "invalid_response", MayHaveExecuted: true}
	}
	return nil
}

func (c *Client) validateReceipt(receipt *Receipt, id string) error {
	if receipt.OperationID != id || receipt.Action == "" || receipt.CreatedAt.IsZero() || receipt.UpdatedAt.IsZero() {
		return &APIError{Code: "invalid_receipt"}
	}
	switch receipt.State {
	case StateExecuting, StateSucceeded, StateFailed, StateCancelled, StateUnknown:
	default:
		return &APIError{Code: "invalid_receipt"}
	}
	if receipt.Error != nil {
		receipt.Error.Code = safeCode(receipt.Error.Code)
		receipt.Error.Message = receipt.Error.Code
	}
	return nil
}

func safeCode(code string) string {
	switch code {
	case "operation_result_retired", "operation_not_terminal":
		return code
	case "sandbox_connection_unavailable":
		return code
	case "archive_destination_exists", "archive_atomic_publish_unavailable", "archive_cleanup_unknown", "archive_invalid", "archive_failed", "archive_timeout":
		return code
	case "invalid_transfer", "invalid_digest", "invalid_offset", "template_stdin_unsupported", "transfer_conflict", "transfer_capacity", "transfer_not_found", "transfer_finalized", "transfer_expired", "transfer_out_of_order", "transfer_incomplete", "digest_mismatch", "file_changed", "source_changed", "source_limit", "unsupported_format", "xml_limit", "zip_entries_limit", "unsafe_archive", "zip_expansion_limit", "unsafe_relationship", "encrypted_pdf", "page_limit", "pdf_stream_limit", "paragraph_limit", "cell_limit", "sheet_limit", "invalid_workbook", "invalid_cell", "invalid_shared_string", "invalid_presentation", "parse_timeout", "parser_dependency_missing", "parse_failed":
		return code
	case "unauthorized", "e2b_disabled", "executor_busy", "ledger_capacity", "operation_not_found", "operation_conflict", "invalid_request", "invalid_identifier", "unsupported_action", "unsupported_field", "sandbox_required", "input_limit", "invalid_timeout", "unsupported_language", "invalid_path", "file_limit", "invalid_base64", "sandbox_not_found", "sandbox_paused", "unsafe_sandbox_policy", "unsafe_envd_version", "reconcile_limit", "cancelled", "execution_timeout", "output_limit", "execution_unknown", "provider_error", "process_interrupted", "receipt_write_failed", "sandbox_initialization_failed", "sandbox_file_error", "result_limit", "cancel_outcome_unknown", "operation_timeout", "shutting_down", "body_limit", "json_required", "invalid_json", "not_found":
		return code
	default:
		return "executor_error"
	}
}
