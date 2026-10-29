package account

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

const CloudAllocationSchema = `
CREATE TABLE IF NOT EXISTS zeroagent_cloud_tool_daily_budget (
 user_id BIGINT NOT NULL,allocation_day DATE NOT NULL,allocated_seconds BIGINT NOT NULL CHECK(allocated_seconds>=0),PRIMARY KEY(user_id,allocation_day));
CREATE TABLE IF NOT EXISTS zeroagent_cloud_allocation_reservations (
 operation_id TEXT PRIMARY KEY CHECK(octet_length(operation_id) BETWEEN 1 AND 128),user_id BIGINT NOT NULL CHECK(user_id>0),
 purpose TEXT NOT NULL CHECK(purpose IN('conversation','file_parser')),allocation_day DATE NOT NULL,
 reserved_seconds BIGINT NOT NULL CHECK(reserved_seconds BETWEEN 1 AND 3600),created_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_allocation_owner_idx ON zeroagent_cloud_allocation_reservations(user_id,allocation_day);`

// The caller owns the transaction. A conversation workspace reservation and its
// quota fact therefore commit or roll back together, as do parser reservations.
func reserveCloudAllocationTx(ctx context.Context, tx *sql.Tx, userID int64, operationID, purpose string, seconds, limit int64, now time.Time) (*CloudAllocationReservation, bool, error) {
	if !validCloudAllocation(userID, operationID, purpose, seconds, limit) {
		return nil, false, ErrCloudToolInvalid
	}
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('zeroagent_cloud_allocation_op:'||$1,0))`, operationID); err != nil {
		return nil, false, err
	}
	var prior CloudAllocationReservation
	err := tx.QueryRowContext(ctx, `SELECT operation_id,user_id,purpose,allocation_day::text,reserved_seconds,created_at FROM zeroagent_cloud_allocation_reservations WHERE operation_id=$1`, operationID).Scan(&prior.OperationID, &prior.UserID, &prior.Purpose, &prior.Day, &prior.Seconds, &prior.CreatedAt)
	if err == nil {
		if !sameCloudAllocation(prior, userID, purpose, seconds) {
			return nil, false, ErrCloudToolConflict
		}
		return &prior, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, false, err
	}
	day := now.UTC().Format("2006-01-02")
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('zeroagent_cloud_tool_budget:'||$1::text||':'||$2,0))`, userID, day); err != nil {
		return nil, false, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_tool_daily_budget(user_id,allocation_day,allocated_seconds) VALUES($1,$2,0) ON CONFLICT DO NOTHING`, userID, day); err != nil {
		return nil, false, err
	}
	var allocated int64
	err = tx.QueryRowContext(ctx, `UPDATE zeroagent_cloud_tool_daily_budget SET allocated_seconds=allocated_seconds+$3 WHERE user_id=$1 AND allocation_day=$2 AND allocated_seconds+$3<=$4 RETURNING allocated_seconds`, userID, day, seconds, limit).Scan(&allocated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, ErrCloudToolQuota
	}
	if err != nil {
		return nil, false, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_allocation_reservations(operation_id,user_id,purpose,allocation_day,reserved_seconds,created_at)VALUES($1,$2,$3,$4,$5,$6)`, operationID, userID, purpose, day, seconds, now)
	if err != nil {
		return nil, false, err
	}
	return &CloudAllocationReservation{OperationID: operationID, UserID: userID, Purpose: purpose, Day: day, Seconds: seconds, CreatedAt: now.UTC()}, true, nil
}
func (s *PersistentStore) ReserveCloudAllocation(ctx context.Context, userID int64, operationID, purpose string, seconds, limit int64) (*CloudAllocationReservation, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()
	now, err := cloudRunDBTime(ctx, tx)
	if err != nil {
		return nil, false, err
	}
	reservation, created, err := reserveCloudAllocationTx(ctx, tx, userID, operationID, purpose, seconds, limit, now)
	if err != nil {
		return nil, false, err
	}
	if err = tx.Commit(); err != nil {
		return nil, false, err
	}
	return reservation, created, nil
}
