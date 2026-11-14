package account

import (
	"context"
	"database/sql"
	"errors"
)

var ErrCloudRunQueueFull = errors.New("account cloud run queue is full")

// Operator policy, never a parameter accepted from users/models. PostgreSQL
// persists the shared policy so replicas cannot claim using different limits.
type CloudRunAdmissionLimits struct {
	MaxExecutingPerAccount int
	MaxQueuedPerAccount    int
}

type CloudRunAdmissionStore interface {
	ConfigureCloudRunAdmission(context.Context, CloudRunAdmissionLimits) error
}

func DefaultCloudRunAdmissionLimits() CloudRunAdmissionLimits {
	return CloudRunAdmissionLimits{MaxExecutingPerAccount: 1, MaxQueuedPerAccount: 20}
}

func normalizeCloudRunAdmission(limits CloudRunAdmissionLimits) (CloudRunAdmissionLimits, error) {
	defaults := DefaultCloudRunAdmissionLimits()
	if limits.MaxExecutingPerAccount == 0 {
		limits.MaxExecutingPerAccount = defaults.MaxExecutingPerAccount
	}
	if limits.MaxQueuedPerAccount == 0 {
		limits.MaxQueuedPerAccount = defaults.MaxQueuedPerAccount
	}
	if limits.MaxExecutingPerAccount < 1 || limits.MaxExecutingPerAccount > 8 || limits.MaxQueuedPerAccount < 1 || limits.MaxQueuedPerAccount > 200 {
		return CloudRunAdmissionLimits{}, ErrCloudRunInvalid
	}
	return limits, nil
}

const cloudRunAdmissionSchema = `
CREATE TABLE IF NOT EXISTS zeroagent_cloud_run_admission_policy (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
 max_executing INTEGER NOT NULL CHECK(max_executing BETWEEN 1 AND 8),
 max_queued INTEGER NOT NULL CHECK(max_queued BETWEEN 1 AND 200),
 revision BIGINT NOT NULL DEFAULT 1,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
INSERT INTO zeroagent_cloud_run_admission_policy(singleton,max_executing,max_queued) VALUES(TRUE,1,20) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS zeroagent_cloud_run_admission_history (
 revision BIGINT PRIMARY KEY,max_executing INTEGER NOT NULL,max_queued INTEGER NOT NULL,changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
INSERT INTO zeroagent_cloud_run_admission_history(revision,max_executing,max_queued) VALUES(1,1,20) ON CONFLICT DO NOTHING;
CREATE SEQUENCE IF NOT EXISTS zeroagent_cloud_run_claim_order;
CREATE TABLE IF NOT EXISTS zeroagent_cloud_run_accounts (
 user_id BIGINT PRIMARY KEY CHECK(user_id>0),last_claim_order BIGINT NOT NULL DEFAULT 0,last_claim_at TIMESTAMPTZ NULL);
INSERT INTO zeroagent_cloud_run_accounts(user_id) SELECT DISTINCT user_id FROM zeroagent_cloud_runs WHERE state IN ('queued','running','cancelling') ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS zeroagent_cloud_run_account_turn_idx ON zeroagent_cloud_run_accounts(last_claim_order,user_id);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_runs_account_active_idx ON zeroagent_cloud_runs(user_id,state) WHERE state IN ('queued','running','cancelling');
CREATE INDEX IF NOT EXISTS zeroagent_cloud_runs_account_pending_idx ON zeroagent_cloud_runs(user_id,created_at,id) WHERE state='queued';`

func (s *MemoryStore) ConfigureCloudRunAdmission(ctx context.Context, limits CloudRunAdmissionLimits) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	limits, err := normalizeCloudRunAdmission(limits)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cloudRunStateLocked().admission = limits
	return nil
}

func (s *PersistentStore) ConfigureCloudRunAdmission(ctx context.Context, limits CloudRunAdmissionLimits) error {
	limits, err := normalizeCloudRunAdmission(limits)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var current CloudRunAdmissionLimits
	var revision int64
	err = tx.QueryRowContext(ctx, `SELECT max_executing,max_queued,revision FROM zeroagent_cloud_run_admission_policy WHERE singleton=TRUE FOR UPDATE`).Scan(&current.MaxExecutingPerAccount, &current.MaxQueuedPerAccount, &revision)
	if err != nil {
		return err
	}
	if current != limits {
		revision++
		if _, err = tx.ExecContext(ctx, `UPDATE zeroagent_cloud_run_admission_policy SET max_executing=$1,max_queued=$2,revision=$3,updated_at=clock_timestamp() WHERE singleton=TRUE`, limits.MaxExecutingPerAccount, limits.MaxQueuedPerAccount, revision); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_run_admission_history(revision,max_executing,max_queued) VALUES($1,$2,$3)`, revision, limits.MaxExecutingPerAccount, limits.MaxQueuedPerAccount); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func cloudRunAdmissionPolicyTx(ctx context.Context, tx *sql.Tx) (CloudRunAdmissionLimits, error) {
	var limits CloudRunAdmissionLimits
	err := tx.QueryRowContext(ctx, `SELECT max_executing,max_queued FROM zeroagent_cloud_run_admission_policy WHERE singleton=TRUE FOR SHARE`).Scan(&limits.MaxExecutingPerAccount, &limits.MaxQueuedPerAccount)
	return limits, err
}

// Every new acceptance/claim takes this same account row before a conversation.
// Derived counts include cancelling/expired leases until durable recovery has
// committed a terminal state; an old worker is never silently considered gone.
func lockCloudRunAdmissionAccount(ctx context.Context, tx *sql.Tx, userID int64) error {
	if _, err := tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_run_accounts(user_id) VALUES($1) ON CONFLICT DO NOTHING`, userID); err != nil {
		return err
	}
	var owner int64
	return tx.QueryRowContext(ctx, `SELECT user_id FROM zeroagent_cloud_run_accounts WHERE user_id=$1 FOR UPDATE`, userID).Scan(&owner)
}
