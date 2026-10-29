package cloudbackup

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

func updateRestoreReport(path string, report *RestoreReport) error {
	report.UpdatedAt = time.Now().UTC()
	encoded, _ := json.MarshalIndent(report, "", "  ")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	if _, err = file.Write(encoded); err != nil {
		return err
	}
	return file.Sync()
}

// Restore targets a fresh isolated database and SDK directory. Partial writes
// are retained with a phase report. It never drops a schema, cleans a bucket,
// overwrites an existing object, resumes an old operation or starts services.
func (e *Engine) Restore(ctx context.Context, root, scope, database, reportPath string) (report *RestoreReport, resultErr error) {
	ctx, cancel, err := e.bounded(ctx)
	if err != nil {
		return nil, err
	}
	defer cancel()
	if err := e.mutationGuard(ctx, scope, database); err != nil {
		return nil, err
	}
	manifest, err := e.verifyLocal(ctx, root)
	if err != nil {
		return nil, err
	}
	if manifest.SourceDatabase == database {
		return nil, ErrInvalid
	}
	if !filepath.IsAbs(reportPath) || privateDirectory(filepath.Dir(reportPath), false) != nil || regular(reportPath) == nil {
		return nil, ErrTargetNotEmpty
	}
	report = &RestoreReport{CandidateID: manifest.ID, Scope: scope, Database: database, Phase: "preflight"}
	if err = writeExclusiveJSON(reportPath, report); err != nil {
		return nil, err
	}
	defer func() {
		if resultErr != nil {
			report.Complete = false
			report.Failure = "restore_failed"
			switch {
			case errors.Is(resultErr, ErrIntegrity):
				report.Failure = "integrity_verification_failed"
			case errors.Is(resultErr, ErrTargetNotEmpty):
				report.Failure = "target_not_empty"
			case errors.Is(resultErr, ErrWriteUnknown):
				report.Failure = "remote_write_unconfirmed"
			case errors.Is(resultErr, ErrConditionalWritesUnsupported):
				report.Failure = "conditional_writes_unsupported"
			case errors.Is(resultErr, ErrConditionalWritesUnconfirmed):
				report.Failure = "conditional_writes_unconfirmed"
			case errors.Is(resultErr, context.Canceled), errors.Is(resultErr, context.DeadlineExceeded):
				report.Failure = "restore_cancelled_or_timed_out"
			}
			var probe *ConditionalWriteError
			if errors.As(resultErr, &probe) {
				details := probe.Probe
				report.WriteProbe = &details
			}
			_ = updateRestoreReport(reportPath, report)
		}
	}()
	// A dedicated connection holds an advisory lock across pg_restore and Redis
	// invalidation; a second restore cannot pass its empty-target check midway.
	connection, err := e.DB.Conn(ctx)
	if err != nil {
		return report, err
	}
	defer connection.Close()
	if _, err = connection.ExecContext(ctx, `SELECT pg_advisory_lock(hashtextextended('zeroagent-cloudchat-isolated-restore',0))`); err != nil {
		return report, err
	}
	defer func() {
		releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if _, unlockErr := connection.ExecContext(releaseCtx, `SELECT pg_advisory_unlock(hashtextextended('zeroagent-cloudchat-isolated-restore',0))`); unlockErr != nil {
			_ = connection.Raw(func(any) error { return driver.ErrBadConn })
		}
	}()
	var count int
	if err = connection.QueryRowContext(ctx, `SELECT
 (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%')+
 (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%')+
 (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%')+
 (SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','public') AND nspname NOT LIKE 'pg_%')+
 (SELECT count(*) FROM pg_largeobject_metadata)`).Scan(&count); err != nil {
		return report, err
	}
	if count != 0 {
		return report, ErrTargetNotEmpty
	}
	if _, err = os.Lstat(e.Config.JournalDirectory); !os.IsNotExist(err) {
		return report, ErrTargetNotEmpty
	}
	if !filepath.IsAbs(e.Config.RestoredConfigPath) || privateDirectory(filepath.Dir(e.Config.RestoredConfigPath), false) != nil {
		return report, ErrInvalid
	}
	if _, err = os.Lstat(e.Config.RestoredConfigPath); !os.IsNotExist(err) {
		return report, ErrTargetNotEmpty
	}
	for _, resource := range manifest.Resources {
		if _, headErr := e.Objects.Head(ctx, resource.Key); headErr == nil {
			return report, ErrTargetNotEmpty
		} else if !missingObject(headErr) {
			return report, headErr
		}
	}
	report.Phase = "verify_restore_write_semantics"
	if err = updateRestoreReport(reportPath, report); err != nil {
		return report, err
	}
	if err = e.Objects.CheckRestoreWriteSemantics(ctx); err != nil {
		return report, err
	}
	report.WriteSemanticsVerified = true
	report.Phase = "restore_database"
	if err = updateRestoreReport(reportPath, report); err != nil {
		return report, err
	}
	if err = runPG(ctx, e.Config, true, "--no-owner", "--no-privileges", "--exit-on-error", "--dbname="+database, filepath.Join(root, manifest.Dump.Path)); err != nil {
		return report, err
	}
	// Compare all restored table counts before the intentional authentication and
	// active-work fences alter any row count or status.
	tx, err := e.DB.BeginTx(ctx, nil)
	if err != nil {
		return report, err
	}
	tables, err := e.tableFacts(ctx, tx, false)
	_ = tx.Rollback()
	if err != nil || string(mustJSON(tables)) != string(mustJSON(manifest.Tables)) {
		return report, ErrIntegrity
	}
	report.Phase = "invalidate_authentication"
	_ = updateRestoreReport(reportPath, report)
	if err = e.InvalidateAuthentication(ctx, scope, database); err != nil {
		return report, err
	}
	report.AuthInvalidated = true
	report.Phase = "restore_objects"
	_ = updateRestoreReport(reportPath, report)
	for _, resource := range manifest.Resources {
		if err = restoreObject(ctx, e.Objects, root, resource); err != nil {
			return report, err
		}
	}
	report.Phase = "restore_journal"
	_ = updateRestoreReport(reportPath, report)
	if err = privateDirectory(e.Config.JournalDirectory, true); err != nil {
		return report, err
	}
	source, err := os.Open(filepath.Join(root, manifest.JournalFile.Path))
	if err != nil {
		return report, err
	}
	defer source.Close()
	target, err := os.OpenFile(filepath.Join(e.Config.JournalDirectory, "receipts.sqlite"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return report, err
	}
	_, err = copyBounded(ctx, target, source, manifest.JournalFile.Bytes)
	syncErr := target.Sync()
	target.Close()
	if err != nil {
		return report, err
	}
	if syncErr != nil {
		return report, syncErr
	}
	journal, err := verifyJournal(ctx, e.Config, filepath.Join(e.Config.JournalDirectory, "receipts.sqlite"))
	if err != nil || journal != manifest.JournalSummary {
		return report, ErrIntegrity
	}
	report.Phase = "restore_protected_configuration"
	_ = updateRestoreReport(reportPath, report)
	plaintext, err := e.unsealConfiguration(root, manifest)
	if err != nil {
		return report, err
	}
	configuration, err := os.OpenFile(e.Config.RestoredConfigPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return report, err
	}
	_, err = configuration.Write(plaintext)
	syncErr = configuration.Sync()
	configuration.Close()
	if err != nil {
		return report, err
	}
	if syncErr != nil {
		return report, syncErr
	}
	report.Phase = "verify_restored_resources"
	_ = updateRestoreReport(reportPath, report)
	if _, err = e.Verify(ctx, root); err != nil {
		return report, err
	}
	for _, directory := range []string{e.Config.JournalDirectory, filepath.Dir(e.Config.JournalDirectory), filepath.Dir(e.Config.RestoredConfigPath)} {
		if err = syncDirectory(directory); err != nil {
			return report, err
		}
	}
	report.Phase = "complete"
	report.Complete = true
	if err = updateRestoreReport(reportPath, report); err != nil {
		return report, err
	}
	return report, nil
}
