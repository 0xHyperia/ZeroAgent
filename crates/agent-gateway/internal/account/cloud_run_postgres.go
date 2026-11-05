package account

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/lib/pq"
)

// CloudRunSchema extends the current cloud store without rewriting user history.
// A queued row is itself durable pending work; events are committed before a
// transport notification may be emitted. Existing internal table names remain.
const CloudRunSchema = `
CREATE TABLE IF NOT EXISTS zeroagent_cloud_runs (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES zerobox_cloud_conversations(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  session_ref TEXT NOT NULL CHECK (session_ref ~ '^[0-9a-fA-F]{64}$'),
  client_request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-fA-F]{64}$'),
  model TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL DEFAULT '',
  provider_key_id BIGINT NOT NULL DEFAULT 0,
  model_parameters JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(model_parameters::text) <= 8192),
  public_research JSONB NOT NULL DEFAULT 'null'::jsonb CHECK (octet_length(public_research::text) <= 65536),
  request_content JSONB NOT NULL,
  user_message_id UUID NOT NULL,
  assistant_message_id UUID NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','cancelling','completed','failed','cancelled','interrupted')),
  output TEXT NOT NULL DEFAULT '' CHECK (octet_length(output) <= 8388608),
  usage JSONB NULL,
  error_code TEXT NOT NULL DEFAULT '',
  lease_owner TEXT NOT NULL DEFAULT '',
  attempt BIGINT NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ NULL,
  last_seq BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT zeroagent_cloud_runs_request_key UNIQUE (user_id,client_request_id),
  CONSTRAINT zeroagent_cloud_runs_owner_key UNIQUE (id,user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS zeroagent_cloud_runs_active_conversation_idx
  ON zeroagent_cloud_runs (conversation_id) WHERE state IN ('queued','running','cancelling');
CREATE INDEX IF NOT EXISTS zeroagent_cloud_runs_pending_idx
  ON zeroagent_cloud_runs (created_at,id) WHERE state='queued';
CREATE INDEX IF NOT EXISTS zeroagent_cloud_runs_history_idx
  ON zeroagent_cloud_runs (user_id,conversation_id,created_at DESC);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_runs_turn_idx
  ON zeroagent_cloud_runs (user_id,conversation_id,user_message_id);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_runs_lease_idx
  ON zeroagent_cloud_runs (lease_until) WHERE state IN ('running','cancelling');
CREATE TABLE IF NOT EXISTS zeroagent_cloud_run_events (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL,
  user_id BIGINT NOT NULL,
  seq BIGINT NOT NULL CHECK (seq > 0),
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  operation_id TEXT NULL,
  operation_hash TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT zeroagent_cloud_run_events_owner_fk FOREIGN KEY (run_id,user_id)
    REFERENCES zeroagent_cloud_runs(id,user_id) ON DELETE CASCADE,
  CONSTRAINT zeroagent_cloud_run_events_sequence_key UNIQUE (run_id,seq),
  CONSTRAINT zeroagent_cloud_run_events_operation_key UNIQUE (run_id,operation_id)
);
ALTER TABLE zeroagent_cloud_runs ADD COLUMN IF NOT EXISTS model_parameters JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE zeroagent_cloud_runs ADD COLUMN IF NOT EXISTS public_research JSONB NOT NULL DEFAULT 'null'::jsonb;
ALTER TABLE zeroagent_cloud_runs ADD COLUMN IF NOT EXISTS presentation JSONB NULL;
ALTER TABLE zerobox_cloud_messages ADD COLUMN IF NOT EXISTS presentation JSONB NULL;` + cloudRunAdmissionSchema + CloudPendingQueueSchema + CloudConversationManagementSchema + CloudPrivateDraftSchema

const cloudRunColumns = `r.id::text,r.conversation_id::text,r.user_id,r.session_ref,r.client_request_id,
r.request_hash,r.model,r.reasoning_effort,r.provider_key_id,r.model_parameters,r.public_research,r.request_content,r.user_message_id::text,
r.assistant_message_id::text,r.state,r.output,r.usage,r.error_code,r.lease_owner,r.attempt,r.lease_until,
r.last_seq,r.created_at,r.updated_at,r.presentation`

type cloudRunScanner interface{ Scan(...any) error }

func scanCloudRun(row cloudRunScanner) (*CloudRun, error) {
	var run CloudRun
	var lease sql.NullTime
	var content, usage, parameters, publicResearch, presentation []byte
	err := row.Scan(&run.ID, &run.ConversationID, &run.UserID, &run.SessionRef, &run.ClientRequestID,
		&run.RequestHash, &run.Model, &run.ReasoningEffort, &run.ProviderKeyID, &parameters, &publicResearch, &content, &run.UserMessageID,
		&run.AssistantMessageID, &run.State, &run.Output, &usage, &run.ErrorCode, &run.LeaseOwner, &run.Attempt, &lease,
		&run.LastSeq, &run.CreatedAt, &run.UpdatedAt, &presentation)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(parameters, &run.ModelParameters); err != nil {
		return nil, ErrCloudRunInvalid
	}
	if run.ModelParameters, err = normalizeCloudModelParameters(run.ModelParameters); err != nil {
		return nil, err
	}
	if err = json.Unmarshal(publicResearch, &run.PublicResearch); err != nil {
		return nil, ErrCloudRunInvalid
	}
	if run.PublicResearch, err = normalizeCloudPublicResearch(run.PublicResearch); err != nil {
		return nil, err
	}
	if lease.Valid {
		run.LeaseUntil = lease.Time
	}
	run.Presentation = append(json.RawMessage(nil), presentation...)
	run.RequestContent = append(json.RawMessage(nil), content...)
	run.Usage = append(json.RawMessage(nil), usage...)
	return &run, nil
}

func cloudRunDBError(err error) error {
	var pg *pq.Error
	if errors.As(err, &pg) && pg.Code == "23505" {
		if pg.Constraint == "zeroagent_cloud_runs_active_conversation_idx" {
			return ErrCloudRunBusy
		}
		return ErrCloudRunConflict
	}
	return err
}

func cloudRunDBTime(ctx context.Context, tx *sql.Tx) (time.Time, error) {
	var now time.Time
	err := tx.QueryRowContext(ctx, "SELECT clock_timestamp()").Scan(&now)
	return now.UTC(), err
}

func cloudRunNullableJSON(value json.RawMessage) any {
	if len(value) == 0 {
		return nil
	}
	return []byte(value)
}
func cloudRunNullableTime(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value
}

// Lock conversations before runs consistently, including claim and recovery, so
// history deletion (which cascades into runs) cannot deadlock with finalization.
func (s *PersistentStore) lockCloudRun(ctx context.Context, tx *sql.Tx, userID int64, id string) (*CloudRun, error) {
	var err error
	id, err = canonicalCloudRunID(id)
	if err != nil {
		return nil, err
	}
	var conversationID string
	err = tx.QueryRowContext(ctx, `SELECT c.id::text FROM zerobox_cloud_conversations c
JOIN zeroagent_cloud_runs r ON r.conversation_id=c.id
WHERE r.id=$1 AND r.user_id=$2 AND c.user_id=$2 FOR UPDATE OF c`, id, userID).Scan(&conversationID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return scanCloudRun(tx.QueryRowContext(ctx, "SELECT "+cloudRunColumns+" FROM zeroagent_cloud_runs r WHERE r.id=$1 AND r.user_id=$2 FOR UPDATE", id, userID))
}

func persistCloudRun(ctx context.Context, tx *sql.Tx, run *CloudRun) error {
	_, err := tx.ExecContext(ctx, `UPDATE zeroagent_cloud_runs SET state=$3,output=$4,usage=$5,error_code=$6,
lease_owner=$7,attempt=$8,lease_until=$9,last_seq=$10,updated_at=$11,presentation=$12 WHERE id=$1 AND user_id=$2`,
		run.ID, run.UserID, run.State, run.Output, cloudRunNullableJSON(run.Usage), run.ErrorCode, run.LeaseOwner,
		run.Attempt, cloudRunNullableTime(run.LeaseUntil), run.LastSeq, run.UpdatedAt, cloudRunNullableJSON(run.Presentation))
	return err
}

func appendCloudRunDBEvent(ctx context.Context, tx *sql.Tx, run *CloudRun, kind string, payload json.RawMessage, operationID, operationHash string, now time.Time) error {
	if kind == "run."+run.State {
		payload = cloudPresentationTerminalPayload(run, payload, now)
	}
	run.LastSeq++
	run.UpdatedAt = now
	var operation any
	if operationID != "" {
		operation = operationID
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_run_events
(id,run_id,user_id,seq,type,payload,operation_id,operation_hash,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		uuid.NewString(), run.ID, run.UserID, run.LastSeq, kind, []byte(payload), operation, operationHash, now)
	if err != nil {
		return err
	}
	return persistCloudRun(ctx, tx, run)
}

func finishCloudRunDB(ctx context.Context, tx *sql.Tx, run *CloudRun, now time.Time) error {
	if err := reconcileCloudToolsTx(ctx, tx, run, now); err != nil {
		return err
	}
	finishCloudPresentation(run, now)
	if run.Output != "" || cloudPresentationHasContent(run.Presentation) {
		messageAt, err := nextCloudMessageTimeTx(ctx, tx, run.UserID, run.ConversationID, now)
		if err != nil {
			return err
		}
		content, _ := json.Marshal(run.Output)
		if _, err := tx.ExecContext(ctx, `INSERT INTO zerobox_cloud_messages (id,conversation_id,user_id,role,content,usage,created_at,presentation)
VALUES ($1,$2,$3,'assistant',$4,$5,$6,$7)`, run.AssistantMessageID, run.ConversationID, run.UserID, content, cloudRunNullableJSON(run.Usage), messageAt, cloudRunNullableJSON(run.Presentation)); err != nil {
			return err
		}
		now = messageAt
	}
	if _, err := tx.ExecContext(ctx, `UPDATE zerobox_cloud_conversations SET updated_at=$3 WHERE id=$1 AND user_id=$2`, run.ConversationID, run.UserID, now); err != nil {
		return err
	}
	run.LeaseOwner, run.LeaseUntil = "", time.Time{}
	return nil
}

func (s *PersistentStore) CreateCloudRun(ctx context.Context, input *CloudRun) (*CloudRun, bool, error) {
	run, err := prepareCloudRun(input, time.Now())
	if err != nil {
		return nil, false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()
	// Serialize the idempotency key before touching any conversation, including
	// simultaneous submissions of that key to different conversations.
	key := strconv.FormatInt(run.UserID, 10) + ":" + run.ClientRequestID
	if _, err = tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", key); err != nil {
		return nil, false, err
	}
	existing, err := scanCloudRun(tx.QueryRowContext(ctx, "SELECT "+cloudRunColumns+` FROM zeroagent_cloud_runs r
JOIN zerobox_cloud_conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id
WHERE r.user_id=$1 AND r.client_request_id=$2`, run.UserID, run.ClientRequestID))
	if err == nil {
		if existing.RequestHash != run.RequestHash || existing.ConversationID != run.ConversationID {
			return nil, false, ErrCloudRunConflict
		}
		if err = tx.Commit(); err != nil {
			return nil, false, err
		}
		return existing, false, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return nil, false, err
	}
	limits, err := cloudRunAdmissionPolicyTx(ctx, tx)
	if err != nil {
		return nil, false, err
	}
	if err = lockCloudRunAdmissionAccount(ctx, tx, run.UserID); err != nil {
		return nil, false, err
	}
	var title string
	err = tx.QueryRowContext(ctx, `SELECT title FROM zerobox_cloud_conversations WHERE id=$1 AND user_id=$2 FOR UPDATE`, run.ConversationID, run.UserID).Scan(&title)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, ErrNotFound
	}
	if err != nil {
		return nil, false, err
	}
	var active bool
	err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zeroagent_cloud_runs WHERE conversation_id=$1 AND state IN ('queued','running','cancelling'))`, run.ConversationID).Scan(&active)
	if err != nil {
		return nil, false, err
	}
	if active {
		return nil, false, ErrCloudRunBusy
	}
	var queued int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM zeroagent_cloud_runs WHERE user_id=$1 AND state='queued'`, run.UserID).Scan(&queued); err != nil {
		return nil, false, err
	}
	if queued >= limits.MaxQueuedPerAccount {
		return nil, false, ErrCloudRunQueueFull
	}
	now, err := cloudRunDBTime(ctx, tx)
	if err != nil {
		return nil, false, err
	}
	run.CreatedAt, run.UpdatedAt = now, now
	if err = consumeCloudPendingTx(ctx, tx, run); err != nil {
		return nil, false, err
	}
	if run.historyEdit != nil {
		if err = truncateCloudRunHistoryTx(ctx, tx, run); err != nil {
			return nil, false, err
		}
		run.historyEdit = nil
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_runs
(id,conversation_id,user_id,session_ref,client_request_id,request_hash,model,reasoning_effort,provider_key_id,model_parameters,public_research,
request_content,user_message_id,assistant_message_id,state,created_at,updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'queued',$15,$15)`,
		run.ID, run.ConversationID, run.UserID, run.SessionRef, run.ClientRequestID, run.RequestHash, run.Model, run.ReasoningEffort,
		run.ProviderKeyID, []byte(cloudJSON(run.ModelParameters)), []byte(cloudJSON(run.PublicResearch)), []byte(run.RequestContent), run.UserMessageID, run.AssistantMessageID, now)
	if err != nil {
		return nil, false, cloudRunDBError(err)
	}
	messageAt, err := nextCloudMessageTimeTx(ctx, tx, run.UserID, run.ConversationID, now)
	if err != nil {
		return nil, false, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO zerobox_cloud_messages (id,conversation_id,user_id,role,content,created_at)
VALUES ($1,$2,$3,'user',$4,$5)`, run.UserMessageID, run.ConversationID, run.UserID, []byte(run.RequestContent), messageAt)
	if err != nil {
		return nil, false, cloudRunDBError(err)
	}
	if title == "" || title == "新对话" {
		title = cloudConversationTitle(run.RequestContent)
	}
	_, err = tx.ExecContext(ctx, `UPDATE zerobox_cloud_conversations SET title=$3,model=$4,updated_at=$5 WHERE id=$1 AND user_id=$2`, run.ConversationID, run.UserID, title, run.Model, messageAt)
	if err != nil {
		return nil, false, err
	}
	if err = appendCloudRunDBEvent(ctx, tx, run, "run.queued", cloudRunEventPayload(run.State, "", ""), "", "", now); err != nil {
		return nil, false, err
	}
	if err = tx.Commit(); err != nil {
		return nil, false, err
	}
	return run, true, nil
}

func (s *PersistentStore) GetCloudRun(ctx context.Context, userID int64, id string) (*CloudRun, error) {
	var err error
	id, err = canonicalCloudRunID(id)
	if err != nil {
		return nil, err
	}
	return scanCloudRun(s.db.QueryRowContext(ctx, "SELECT "+cloudRunColumns+` FROM zeroagent_cloud_runs r
JOIN zerobox_cloud_conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id
WHERE r.id=$1 AND r.user_id=$2`, id, userID))
}

func (s *PersistentStore) ListCloudRuns(ctx context.Context, userID int64, conversationID string, activeOnly bool) ([]CloudRun, error) {
	var err error
	conversationID, err = canonicalCloudRunID(conversationID)
	if err != nil {
		return nil, err
	}
	var exists bool
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zerobox_cloud_conversations WHERE id=$1 AND user_id=$2)`, conversationID, userID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+cloudRunColumns+` FROM zeroagent_cloud_runs r
JOIN zerobox_cloud_conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id
WHERE r.user_id=$1 AND r.conversation_id=$2 AND (NOT $3 OR r.state IN ('queued','running','cancelling'))
ORDER BY r.created_at DESC,r.id DESC LIMIT 100`, userID, conversationID, activeOnly)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]CloudRun, 0)
	for rows.Next() {
		run, err := scanCloudRun(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *run)
	}
	return result, rows.Err()
}

func (s *PersistentStore) ClaimCloudRun(ctx context.Context, owner string, lease time.Duration) (*CloudRun, error) {
	if err := normalizeCloudRunLease(owner, lease); err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	limits, err := cloudRunAdmissionPolicyTx(ctx, tx)
	if err != nil {
		return nil, err
	}
	var accountID int64
	err = tx.QueryRowContext(ctx, `SELECT a.user_id FROM zeroagent_cloud_run_accounts a
JOIN (SELECT r.user_id,min(r.created_at) AS oldest_queued FROM zeroagent_cloud_runs r
 JOIN zerobox_cloud_conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id
 WHERE r.state='queued' GROUP BY r.user_id) queued ON queued.user_id=a.user_id
WHERE (SELECT count(*) FROM zeroagent_cloud_runs active WHERE active.user_id=a.user_id AND active.state IN ('running','cancelling'))<$1
ORDER BY a.last_claim_order,queued.oldest_queued,a.user_id
LIMIT 1 FOR UPDATE OF a SKIP LOCKED`, limits.MaxExecutingPerAccount).Scan(&accountID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	// The selected account row is the cross-worker semaphore. This fresh
	// statement rechecks counts after row-lock acquisition, including a claim
	// that committed while candidate selection was reading its MVCC snapshot.
	var executing int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM zeroagent_cloud_runs WHERE user_id=$1 AND state IN ('running','cancelling')`, accountID).Scan(&executing); err != nil {
		return nil, err
	}
	if executing >= limits.MaxExecutingPerAccount {
		return nil, ErrNotFound
	}
	var conversationID string
	err = tx.QueryRowContext(ctx, `SELECT c.id::text FROM zerobox_cloud_conversations c
JOIN zeroagent_cloud_runs r ON r.conversation_id=c.id AND r.user_id=c.user_id
WHERE r.state='queued' AND r.user_id=$1 ORDER BY r.created_at,r.id LIMIT 1 FOR UPDATE OF c SKIP LOCKED`, accountID).Scan(&conversationID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	run, err := scanCloudRun(tx.QueryRowContext(ctx, "SELECT "+cloudRunColumns+` FROM zeroagent_cloud_runs r
WHERE r.conversation_id=$1 AND r.state='queued' ORDER BY r.created_at,r.id LIMIT 1 FOR UPDATE SKIP LOCKED`, conversationID))
	if err != nil {
		return nil, err
	}
	now, err := cloudRunDBTime(ctx, tx)
	if err != nil {
		return nil, err
	}
	run.State, run.LeaseOwner, run.LeaseUntil = CloudRunRunning, owner, now.Add(lease)
	run.Attempt++
	if _, err = tx.ExecContext(ctx, `UPDATE zeroagent_cloud_run_accounts SET last_claim_order=nextval('zeroagent_cloud_run_claim_order'),last_claim_at=$2 WHERE user_id=$1`, run.UserID, now); err != nil {
		return nil, err
	}
	if err = appendCloudRunDBEvent(ctx, tx, run, "run.started", cloudRunEventPayload(run.State, "", ""), "", "", now); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return run, nil
}

func (s *PersistentStore) RenewCloudRunLease(ctx context.Context, userID int64, id, owner string, attempt int64, lease time.Duration) (*CloudRun, error) {
	if err := normalizeCloudRunLease(owner, lease); err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	run, err := s.lockCloudRun(ctx, tx, userID, id)
	if err != nil {
		return nil, err
	}
	now, err := cloudRunDBTime(ctx, tx)
	if err != nil {
		return nil, err
	}
	if err = validateCloudRunLease(run, owner, attempt, now); err != nil {
		return nil, err
	}
	run.LeaseUntil, run.UpdatedAt = now.Add(lease), now
	if err = persistCloudRun(ctx, tx, run); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return run, nil
}

func (s *PersistentStore) CommitCloudRun(ctx context.Context, userID int64, id, owner string, attempt int64, update CloudRunCommit) (*CloudRun, error) {
	commit, hash, err := prepareCloudRunCommit(update)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	run, err := s.lockCloudRun(ctx, tx, userID, id)
	if err != nil {
		return nil, err
	}
	id = run.ID
	var previous string
	err = tx.QueryRowContext(ctx, `SELECT operation_hash FROM zeroagent_cloud_run_events WHERE run_id=$1 AND user_id=$2 AND operation_id=$3`, id, userID, commit.OperationID).Scan(&previous)
	if err == nil {
		if previous != hash {
			return nil, ErrCloudRunConflict
		}
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		return run, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	now, err := cloudRunDBTime(ctx, tx)
	if err != nil {
		return nil, err
	}
	if err = validateCloudRunLease(run, owner, attempt, now); err != nil {
		return nil, err
	}
	if run.State == CloudRunCancelling && commit.State != CloudRunCancelled && commit.State != CloudRunInterrupted {
		return nil, ErrCloudRunLeaseLost
	}
	if len(run.Output)+len(commit.Delta) > CloudRunMaxOutputBytes {
		return nil, ErrCloudRunLimit
	}
	run.Output += commit.Delta
	if len(commit.Usage) > 0 {
		run.Usage = append(json.RawMessage(nil), commit.Usage...)
	}
	if commit.State != "" {
		run.State = commit.State
	}
	run.ErrorCode = commit.ErrorCode
	if err = applyCloudPresentation(run, &commit, now); err != nil {
		return nil, err
	}
	if run.Terminal() {
		if err = finishCloudRunDB(ctx, tx, run, now); err != nil {
			return nil, err
		}
	}
	if err = appendCloudRunDBEvent(ctx, tx, run, commit.EventType, commit.Payload, commit.OperationID, hash, now); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return run, nil
}

func (s *PersistentStore) CancelCloudRun(ctx context.Context, userID int64, id string) (*CloudRun, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	run, err := s.lockCloudRun(ctx, tx, userID, id)
	if err != nil {
		return nil, err
	}
	if run.Terminal() || run.State == CloudRunCancelling {
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		return run, nil
	}
	now, err := cloudRunDBTime(ctx, tx)
	if err != nil {
		return nil, err
	}
	if run.State == CloudRunQueued {
		run.State = CloudRunCancelled
		if err = finishCloudRunDB(ctx, tx, run, now); err != nil {
			return nil, err
		}
	} else {
		run.State = CloudRunCancelling
	}
	if err = appendCloudRunDBEvent(ctx, tx, run, "run."+run.State, cloudRunEventPayload(run.State, "", ""), "", "", now); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return run, nil
}

func (s *PersistentStore) ListCloudRunEvents(ctx context.Context, userID int64, id string, after int64, limit int) ([]CloudRunEvent, error) {
	if after < 0 {
		return nil, ErrCloudRunInvalid
	}
	run, err := s.GetCloudRunHead(ctx, userID, id)
	if err != nil {
		return nil, err
	}
	id = run.ID
	rows, err := s.db.QueryContext(ctx, `SELECT e.id::text,e.run_id::text,e.seq,e.type,e.payload,e.created_at
FROM zeroagent_cloud_run_events e JOIN zeroagent_cloud_runs r ON r.id=e.run_id AND r.user_id=e.user_id
JOIN zerobox_cloud_conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id
WHERE e.run_id=$1 AND e.user_id=$2 AND e.seq>$3 ORDER BY e.seq LIMIT $4`, id, userID, after, cloudRunEventsLimit(limit))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]CloudRunEvent, 0)
	for rows.Next() {
		var event CloudRunEvent
		event.ConversationID = run.ConversationID
		if err := rows.Scan(&event.ID, &event.RunID, &event.Seq, &event.Type, &event.Payload, &event.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, event)
	}
	return result, rows.Err()
}

func (s *PersistentStore) InterruptExpiredCloudRuns(ctx context.Context) (int, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id::text,user_id FROM zeroagent_cloud_runs
WHERE state IN ('running','cancelling') AND lease_until<=clock_timestamp() ORDER BY lease_until LIMIT 100`)
	if err != nil {
		return 0, err
	}
	type identity struct {
		id   string
		user int64
	}
	pending := make([]identity, 0)
	for rows.Next() {
		var item identity
		if err := rows.Scan(&item.id, &item.user); err != nil {
			rows.Close()
			return 0, err
		}
		pending = append(pending, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	count := 0
	for _, item := range pending {
		changed, err := s.interruptExpiredCloudRun(ctx, item.user, item.id)
		if err != nil {
			return count, err
		}
		if changed {
			count++
		}
	}
	return count, nil
}

func (s *PersistentStore) interruptExpiredCloudRun(ctx context.Context, userID int64, id string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	run, err := s.lockCloudRun(ctx, tx, userID, id)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	now, err := cloudRunDBTime(ctx, tx)
	if err != nil {
		return false, err
	}
	if (run.State != CloudRunRunning && run.State != CloudRunCancelling) || run.LeaseUntil.After(now) {
		return false, nil
	}
	run.State, run.ErrorCode = CloudRunInterrupted, "lease_expired"
	if err = finishCloudRunDB(ctx, tx, run, now); err != nil {
		return false, err
	}
	if err = appendCloudRunDBEvent(ctx, tx, run, "run.interrupted", cloudRunEventPayload(run.State, "", run.ErrorCode), "", "", now); err != nil {
		return false, err
	}
	if err = tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

var _ CloudRunStore = (*MemoryStore)(nil)
var _ CloudRunStore = (*PersistentStore)(nil)
