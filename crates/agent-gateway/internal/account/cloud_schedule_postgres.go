package account

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

const cloudScheduleSchema = `
CREATE TABLE IF NOT EXISTS zeroagent_cloud_execution_accounts (
 user_id BIGINT NOT NULL, source TEXT NOT NULL CHECK (source IN ('web','desktop')),
 session_ref TEXT NOT NULL, refresh_at TIMESTAMPTZ,
 PRIMARY KEY (user_id,source)
);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_execution_refresh ON zeroagent_cloud_execution_accounts(refresh_at)
 WHERE refresh_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS zeroagent_cloud_schedules (
 id UUID PRIMARY KEY, user_id BIGINT NOT NULL, revision BIGINT NOT NULL DEFAULT 1,
 enabled BOOLEAN NOT NULL DEFAULT true, next_at TIMESTAMPTZ, admitted INTEGER NOT NULL DEFAULT 0,
 blocked TEXT NOT NULL DEFAULT '', spec JSONB NOT NULL, deleted_at TIMESTAMPTZ,
 UNIQUE (id,user_id)
);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_schedules_owner ON zeroagent_cloud_schedules(user_id,id);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_schedules_due ON zeroagent_cloud_schedules(next_at,id) WHERE enabled;
CREATE TABLE IF NOT EXISTS zeroagent_cloud_schedule_occurrences (
 id UUID PRIMARY KEY, task_id UUID NOT NULL, user_id BIGINT NOT NULL, trigger_at TIMESTAMPTZ NOT NULL,
 manual BOOLEAN NOT NULL, spec JSONB NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
 lease_owner TEXT NOT NULL DEFAULT '', lease_until TIMESTAMPTZ, run_id UUID,
 error_code TEXT NOT NULL DEFAULT '', approval_decision TEXT NOT NULL DEFAULT '', approved_at TIMESTAMPTZ,
 FOREIGN KEY(task_id,user_id) REFERENCES zeroagent_cloud_schedules(id,user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_schedule_history ON zeroagent_cloud_schedule_occurrences(task_id,trigger_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS zeroagent_cloud_schedule_trigger ON zeroagent_cloud_schedule_occurrences(task_id,trigger_at) WHERE NOT manual;
CREATE UNIQUE INDEX IF NOT EXISTS zeroagent_cloud_schedule_dispatch ON zeroagent_cloud_schedule_occurrences(task_id) WHERE state='pending';
`

const cloudScheduleFields = `id::text,revision,enabled,next_at,admitted,blocked,spec`

func scanCloudSchedule(row interface{ Scan(...any) error }, task *CloudSchedule, extra ...any) error {
	var spec []byte
	fields := []any{&task.ID, &task.Revision, &task.Enabled, &task.NextAt, &task.Admitted, &task.Blocked, &spec}
	if err := row.Scan(append(fields, extra...)...); err != nil {
		return err
	}
	return json.Unmarshal(spec, &task.CloudScheduleInput)
}

func (s *PersistentStore) listCloudSchedules(ctx context.Context, uid int64) ([]CloudSchedule, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+cloudScheduleFields+`,COALESCE(latest.state,'')
 FROM zeroagent_cloud_schedules s LEFT JOIN LATERAL (
  SELECT COALESCE(r.state,o.state) AS state FROM zeroagent_cloud_schedule_occurrences o
  LEFT JOIN zeroagent_cloud_runs r ON r.id=o.run_id AND r.user_id=o.user_id
  WHERE o.task_id=s.id AND o.user_id=s.user_id
  ORDER BY (o.state='awaiting_approval') DESC,o.trigger_at DESC,o.id DESC LIMIT 1
 ) latest ON true WHERE s.user_id=$1 AND s.deleted_at IS NULL ORDER BY next_at NULLS LAST,id`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]CloudSchedule, 0)
	for rows.Next() {
		var task CloudSchedule
		if err := scanCloudSchedule(rows, &task, &task.LatestState); err != nil {
			return nil, err
		}
		items = append(items, task)
	}
	return items, rows.Err()
}

const cloudScheduleRunRows = `SELECT o.id::text,o.trigger_at,o.manual,COALESCE(r.state,o.state),COALESCE(r.conversation_id::text,''),COALESCE(r.id::text,''),COALESCE(left(r.output,4000),''),COALESCE(r.error_code,o.error_code),COALESCE(c.archived,false),CASE WHEN o.state='awaiting_approval' THEN o.spec ELSE NULL END
 FROM zeroagent_cloud_schedule_occurrences o LEFT JOIN zeroagent_cloud_runs r ON r.id=o.run_id AND r.user_id=o.user_id
 LEFT JOIN zerobox_cloud_conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id`

func scanCloudScheduleRun(row interface{ Scan(...any) error }) (CloudScheduleRun, error) {
	var item CloudScheduleRun
	var approval []byte
	if err := row.Scan(&item.ID, &item.TriggerAt, &item.Manual, &item.State, &item.ConversationID, &item.RunID, &item.Output, &item.ErrorCode, &item.Archived, &approval); err != nil {
		return CloudScheduleRun{}, err
	}
	if len(approval) != 0 {
		if err := json.Unmarshal(approval, &item.Approval); err != nil {
			return CloudScheduleRun{}, err
		}
	}
	return item, nil
}

func (s *PersistentStore) cloudScheduleRuns(ctx context.Context, uid int64, task string) ([]CloudScheduleRun, error) {
	var exists bool
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zeroagent_cloud_schedules WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL)`, task, uid).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	rows, err := s.db.QueryContext(ctx, cloudScheduleRunRows+`
 WHERE o.task_id=$1 AND o.user_id=$2 ORDER BY (o.state='awaiting_approval') DESC,o.trigger_at DESC,o.id DESC LIMIT 100`, task, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]CloudScheduleRun, 0)
	for rows.Next() {
		item, err := scanCloudScheduleRun(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PersistentStore) cloudScheduleRun(ctx context.Context, uid int64, task, occurrence string) (CloudScheduleRun, error) {
	return scanCloudScheduleRun(s.db.QueryRowContext(ctx, cloudScheduleRunRows+`
 WHERE o.task_id=$1 AND o.user_id=$2 AND o.id=$3
 AND EXISTS (SELECT 1 FROM zeroagent_cloud_schedules s WHERE s.id=o.task_id AND s.user_id=o.user_id AND s.deleted_at IS NULL)`, task, uid, occurrence))
}

func (s *PersistentStore) deleteCloudSchedule(ctx context.Context, uid int64, id string, now time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var alreadyDeleted bool
	if err = tx.QueryRowContext(ctx, `SELECT deleted_at IS NOT NULL FROM zeroagent_cloud_schedules
 WHERE id=$1 AND user_id=$2 FOR UPDATE`, id, uid).Scan(&alreadyDeleted); err != nil {
		return err
	}
	if alreadyDeleted {
		return tx.Commit()
	}
	if _, err = tx.ExecContext(ctx, `UPDATE zeroagent_cloud_schedules
 SET deleted_at=$3,enabled=false,next_at=NULL,revision=revision+1 WHERE id=$1 AND user_id=$2`, id, uid, now); err != nil {
		return err
	}
	// A leased dispatch may already have committed a Cloud Run. Keep its receipt
	// for the worker to settle. Unclaimed or unapproved work cannot start later.
	if _, err = tx.ExecContext(ctx, `UPDATE zeroagent_cloud_schedule_occurrences SET state='cancelled'
 WHERE task_id=$1 AND user_id=$2 AND (state='awaiting_approval' OR (state='pending' AND lease_owner=''))`, id, uid); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *PersistentStore) cancelPendingCloudSchedule(ctx context.Context, uid int64, task, run string) error {
	result, err := s.db.ExecContext(ctx, `UPDATE zeroagent_cloud_schedule_occurrences SET state='cancelled'
 WHERE id=$1 AND task_id=$2 AND user_id=$3 AND (state='cancelled' OR (state='pending' AND lease_owner=''))`, run, task, uid)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err == nil && count == 0 {
		// The dispatcher may be recording an already admitted Cloud Run. Wait
		// for its receipt before directing cancellation to that Run.
		return ErrCloudRunConflict
	}
	return err
}

func (s *PersistentStore) cloudScheduleApprovalDecision(ctx context.Context, uid int64, task, run string) (string, error) {
	var decision string
	err := s.db.QueryRowContext(ctx, `SELECT CASE
 WHEN o.approval_decision<>'' THEN o.approval_decision
 WHEN o.state='awaiting_approval' THEN 'pending'
 ELSE 'unavailable' END
 FROM zeroagent_cloud_schedule_occurrences o JOIN zeroagent_cloud_schedules s ON s.id=o.task_id AND s.user_id=o.user_id
 WHERE o.id=$1 AND o.task_id=$2 AND o.user_id=$3 AND s.deleted_at IS NULL`, run, task, uid).Scan(&decision)
	return decision, err
}

func (s *PersistentStore) decideCloudScheduleApproval(ctx context.Context, uid int64, task, run, decision string, now time.Time) error {
	state := "rejected"
	if decision == "approve" {
		state = "pending"
	}
	result, err := s.db.ExecContext(ctx, `UPDATE zeroagent_cloud_schedule_occurrences o
 SET state=$4,approved_at=CASE WHEN $5='approve' THEN $6::timestamptz ELSE NULL END,approval_decision=$5
 FROM zeroagent_cloud_schedules s
 WHERE o.id=$1 AND o.task_id=$2 AND o.user_id=$3 AND o.state='awaiting_approval' AND o.approval_decision=''
 AND s.id=o.task_id AND s.user_id=o.user_id AND s.deleted_at IS NULL`, run, task, uid, state, decision, now)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count != 0 {
		return err
	}
	// Another request may have recorded a decision since the handler checked.
	stored, err := s.cloudScheduleApprovalDecision(ctx, uid, task, run)
	if err != nil || stored == decision {
		return err
	}
	return errCloudScheduleApprovalConflict
}

func cloudScheduleActive(ctx context.Context, tx *sql.Tx, id string) (bool, error) {
	var active bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zeroagent_cloud_schedule_occurrences o
 LEFT JOIN zeroagent_cloud_runs r ON r.id=o.run_id AND r.user_id=o.user_id WHERE o.task_id=$1
 AND (o.state IN ('pending','awaiting_approval') OR r.state IN ('queued','running','cancelling')))`, id).Scan(&active)
	return active, err
}

func cloudScheduleID(id, suffix string) string {
	return uuid.NewSHA1(uuid.MustParse(id), []byte(suffix)).String()
}

func (s *PersistentStore) queueCloudSchedule(ctx context.Context, uid int64, taskID, manualID string, now time.Time) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var task CloudSchedule
	err = scanCloudSchedule(tx.QueryRowContext(ctx, `SELECT `+cloudScheduleFields+` FROM zeroagent_cloud_schedules WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`, taskID, uid), &task)
	if err != nil {
		return "", err
	}
	id := cloudScheduleID(taskID, "manual:"+manualID)
	var exists bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zeroagent_cloud_schedule_occurrences WHERE id=$1 AND user_id=$2)`, id, uid).Scan(&exists); err != nil {
		return "", err
	}
	if exists {
		return id, tx.Commit()
	}
	active, err := cloudScheduleActive(ctx, tx, taskID)
	if err != nil {
		return "", err
	}
	if active {
		return "", ErrCloudRunBusy
	}
	spec, err := encodeCloudSchedule(task.CloudScheduleInput)
	if err != nil {
		return "", err
	}
	state := "pending"
	if task.RequireApproval {
		state = "awaiting_approval"
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_schedule_occurrences(id,task_id,user_id,trigger_at,manual,spec,state) VALUES ($1,$2,$3,$4,true,$5,$6)`, id, taskID, uid, now, string(spec), state)
	if err != nil {
		return "", err
	}
	return id, tx.Commit()
}

func (s *PersistentStore) enqueueDueCloudSchedule(ctx context.Context, now time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var task CloudSchedule
	var uid int64
	var raw []byte
	err = tx.QueryRowContext(ctx, `SELECT `+cloudScheduleFields+`,user_id FROM zeroagent_cloud_schedules
 WHERE enabled AND next_at <= $1 ORDER BY next_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, now).Scan(&task.ID, &task.Revision, &task.Enabled, &task.NextAt, &task.Admitted, &task.Blocked, &raw, &uid)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if err = json.Unmarshal(raw, &task.CloudScheduleInput); err != nil {
		return err
	}
	due := *task.NextAt
	for next := task.Rule.next(now.Add(-cloudScheduleGrace-time.Nanosecond), task.Admitted); next != nil && !next.After(now); next = task.Rule.next(*next, task.Admitted) {
		if next.After(due) {
			due = *next
		}
	}
	state, reason := "pending", ""
	active, err := cloudScheduleActive(ctx, tx, task.ID)
	if err != nil {
		return err
	}
	if due.Before(now.Add(-cloudScheduleGrace)) {
		state, reason = "skipped", "missed"
	} else if active {
		state, reason = "skipped", "overlap"
	} else if task.RequireApproval {
		state = "awaiting_approval"
	}
	id := cloudScheduleID(task.ID, "scheduled:"+due.UTC().Format(time.RFC3339Nano))
	if _, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_schedule_occurrences(id,task_id,user_id,trigger_at,manual,spec,state,error_code) VALUES ($1,$2,$3,$4,false,$5,$6,$7) ON CONFLICT (id) DO NOTHING`, id, task.ID, uid, due, string(raw), state, reason); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE zeroagent_cloud_schedules SET next_at=$2 WHERE id=$1`, task.ID, task.Rule.next(now, task.Admitted)); err != nil {
		return err
	}
	return tx.Commit()
}

type cloudScheduleDispatch struct {
	id, task, owner string
	uid             int64
	manual          bool
	trigger         time.Time
	readyAt         time.Time
	input           CloudScheduleInput
}

func (s *PersistentStore) claimCloudSchedule(ctx context.Context, now time.Time) (*cloudScheduleDispatch, error) {
	item := &cloudScheduleDispatch{owner: uuid.NewString()}
	var spec []byte
	err := s.db.QueryRowContext(ctx, `UPDATE zeroagent_cloud_schedule_occurrences SET lease_owner=$2,lease_until=$1+interval '30 seconds'
 WHERE id=(SELECT id FROM zeroagent_cloud_schedule_occurrences WHERE state='pending' AND (lease_until IS NULL OR lease_until <= $1)
 ORDER BY trigger_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
 RETURNING id::text,task_id::text,user_id,manual,trigger_at,COALESCE(approved_at,trigger_at),spec`, now, item.owner).Scan(&item.id, &item.task, &item.uid, &item.manual, &item.trigger, &item.readyAt, &spec)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return item, json.Unmarshal(spec, &item.input)
}

func (s *PersistentStore) prepareCloudScheduleConversation(ctx context.Context, item *cloudScheduleDispatch, id string, now time.Time) error {
	const insertConversation = `INSERT INTO zerobox_cloud_conversations(id,user_id,title,model,created_at,updated_at)
VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT (id) DO NOTHING`
	project := item.input.ProjectID
	if project == "" {
		_, err := s.db.ExecContext(ctx, insertConversation, id, item.uid, item.input.Name, item.input.Run.Model, now)
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var found string
	if err := tx.QueryRowContext(ctx, `SELECT id::text FROM zeroagent_cloud_projects WHERE id=$1 AND user_id=$2 FOR KEY SHARE`, project, item.uid).Scan(&found); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	result, err := tx.ExecContext(ctx, insertConversation, id, item.uid, item.input.Name, item.input.Run.Model, now)
	if err != nil {
		return err
	}
	created, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if created == 1 {
		_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_project_conversations(conversation_id,user_id,project_id,version)
VALUES ($1,$2,$3,1)`, id, item.uid, project)
	} else {
		err = tx.QueryRowContext(ctx, `SELECT COALESCE(b.project_id::text,'') FROM zerobox_cloud_conversations c
LEFT JOIN zeroagent_cloud_project_conversations b ON b.conversation_id=c.id AND b.user_id=c.user_id
WHERE c.id=$1 AND c.user_id=$2`, id, item.uid).Scan(&found)
		if err == nil && found != project {
			return ErrCloudProjectConflict
		}
	}
	if err != nil {
		return cloudProjectSQLError(err)
	}
	return tx.Commit()
}

func cloudScheduleRunSettings(ctx context.Context, db interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, run *CloudRun) (input CloudScheduleInput, err error) {
	id, scheduled := strings.CutPrefix(run.ClientRequestID, "schedule:")
	if !scheduled {
		return input, nil
	}
	if _, err := uuid.Parse(id); err != nil {
		return input, sql.ErrNoRows
	}
	var task string
	err = db.QueryRowContext(ctx, `SELECT task_id::text,COALESCE(spec->>'project_id',''),
COALESCE(spec->>'new_conversation','false')='true',COALESCE(spec->>'archive_successful_runs','false')='true'
FROM zeroagent_cloud_schedule_occurrences WHERE id=$1 AND user_id=$2`, id, run.UserID).Scan(
		&task, &input.ProjectID, &input.NewConversation, &input.ArchiveSuccess)
	if err == nil && input.resultConversation(task, id) != run.ConversationID {
		return input, ErrCloudRunConflict
	}
	return input, err
}

func (s *PersistentStore) finishCloudSchedule(ctx context.Context, item *cloudScheduleDispatch, runID, state, code string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var task CloudSchedule
	if err = scanCloudSchedule(tx.QueryRowContext(ctx, `SELECT `+cloudScheduleFields+` FROM zeroagent_cloud_schedules WHERE id=$1 AND user_id=$2 FOR UPDATE`, item.task, item.uid), &task); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `UPDATE zeroagent_cloud_schedule_occurrences SET state=$3,error_code=$4,run_id=NULLIF($5,'')::uuid,lease_until=NULL WHERE id=$1 AND lease_owner=$2 AND state='pending'`, item.id, item.owner, state, code, runID)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return fmt.Errorf("schedule dispatch lease lost")
	}
	if runID != "" && !item.manual {
		task.Admitted++
		if task.Rule.Count > 0 && task.Admitted >= task.Rule.Count {
			task.NextAt = nil
		}
		_, err = tx.ExecContext(ctx, `UPDATE zeroagent_cloud_schedules SET admitted=$2,next_at=$3 WHERE id=$1`, item.task, task.Admitted, task.NextAt)
	}
	if code == "authorization_required" || (code == "schedule_project_unavailable" && task.ProjectID == item.input.ProjectID) {
		_, err = tx.ExecContext(ctx, `UPDATE zeroagent_cloud_schedules SET enabled=false,next_at=NULL,blocked=$2,revision=revision+1 WHERE id=$1`, item.task, code)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}
