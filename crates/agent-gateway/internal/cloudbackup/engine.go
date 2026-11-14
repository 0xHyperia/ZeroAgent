package cloudbackup

import (
	"context"
	"crypto/hmac"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

func (e *Engine) validate(ctx context.Context) error {
	if e.DB == nil || e.Objects == nil || !identifier.MatchString(e.Config.Schema) || !identifier.MatchString(e.Config.ExpectedDatabase) || len(e.Config.Scope) < 12 || len(e.Config.Scope) > 128 || len(e.Config.BackupEncryptionKey) != 32 {
		return ErrInvalid
	}
	if e.Config.MaxObjects == 0 {
		e.Config.MaxObjects = 100000
	}
	if e.Config.MaxTotalBytes == 0 {
		e.Config.MaxTotalBytes = 64 << 30
	}
	if e.Config.Timeout == 0 {
		e.Config.Timeout = 15 * time.Minute
	}
	if e.Config.MaxObjects < 1 || e.Config.MaxObjects > 1000000 || e.Config.MaxTotalBytes < 1 || e.Config.MaxTotalBytes > 1<<40 || e.Config.Timeout < time.Second || e.Config.Timeout > time.Hour {
		return ErrInvalid
	}
	var database string
	if e.DB.QueryRowContext(ctx, "SELECT current_database()").Scan(&database) != nil || database != e.Config.ExpectedDatabase {
		return ErrInvalid
	}
	return nil
}
func (e *Engine) bounded(ctx context.Context) (context.Context, context.CancelFunc, error) {
	timeout := e.Config.Timeout
	if timeout == 0 {
		timeout = 15 * time.Minute
	}
	if timeout < time.Second || timeout > time.Hour {
		return nil, nil, ErrInvalid
	}
	bounded, cancel := context.WithTimeout(ctx, timeout)
	return bounded, cancel, nil
}
func (e *Engine) tableFacts(ctx context.Context, tx *sql.Tx, lock bool) ([]Table, error) {
	rows, err := tx.QueryContext(ctx, `SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename`, e.Config.Schema)
	if err != nil {
		return nil, err
	}
	tables := []Table{}
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if !identifier.MatchString(name) || (name != "agents" && !strings.HasPrefix(name, "zeroagent_") && !strings.HasPrefix(name, "zerobox_")) {
			_ = rows.Close()
			return nil, ErrInvalid
		}
		tables = append(tables, Table{Name: name})
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	if len(tables) == 0 || len(tables) > 256 {
		return nil, ErrInvalid
	}
	if lock {
		names := []string{}
		for _, table := range tables {
			names = append(names, `"`+e.Config.Schema+`"."`+table.Name+`"`)
		}
		if _, err = tx.ExecContext(ctx, `LOCK TABLE `+strings.Join(names, ",")+` IN SHARE MODE`); err != nil {
			return nil, err
		}
	}
	for index := range tables {
		if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM "`+e.Config.Schema+`"."`+tables[index].Name+`"`).Scan(&tables[index].Rows); err != nil {
			return nil, err
		}
	}
	return tables, nil
}

// Create writes only a new private local bundle. SHARE locks intentionally block
// application writers for this bounded maintenance window, including deletion
// intent before remote DELETE. The stopped SDK lock spans the same interval.
func (e *Engine) Create(ctx context.Context, root string) (*Manifest, error) {
	ctx, cancel, err := e.bounded(ctx)
	if err != nil {
		return nil, err
	}
	defer cancel()
	if err := e.validate(ctx); err != nil {
		return nil, err
	}
	if err := privateDirectory(root, true); err != nil {
		return nil, err
	}
	if err := os.Mkdir(filepath.Join(root, "objects"), 0700); err != nil {
		return nil, err
	}
	guard, err := startJournalGuard(ctx, e.Config, filepath.Join(root, "receipts.sqlite"))
	if err != nil {
		return nil, err
	}
	defer func() { _ = guard.close() }()
	tx, err := e.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `SET LOCAL lock_timeout='5s'`); err != nil {
		return nil, err
	}
	tables, err := e.tableFacts(ctx, tx, true)
	if err != nil {
		return nil, err
	}
	resources, err := e.resources(ctx, tx)
	if err != nil {
		return nil, err
	}
	var snapshot string
	if err = tx.QueryRowContext(ctx, `SELECT pg_export_snapshot()`).Scan(&snapshot); err != nil {
		return nil, err
	}
	dump := filepath.Join(root, "database.dump")
	if err = runPG(ctx, e.Config, false, "--format=custom", "--compress=none", "--no-owner", "--no-privileges", "--schema="+e.Config.Schema, "--snapshot="+snapshot, "--file="+dump); err != nil {
		return nil, err
	}
	if err = os.Chmod(dump, 0600); err != nil {
		return nil, err
	}
	for _, resource := range resources {
		path := filepath.Join(root, filepath.FromSlash(resource.Archive))
		output, openErr := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if os.IsExist(openErr) {
			if err = verifyArchived(ctx, root, resource); err != nil {
				return nil, err
			}
			continue
		}
		if openErr != nil {
			return nil, openErr
		}
		err = verifyObject(ctx, e.Objects, resource, output)
		syncErr := output.Sync()
		closeErr := output.Close()
		if err != nil {
			return nil, err
		}
		if syncErr != nil {
			return nil, syncErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
	}
	dumpInfo, err := hashFileContext(ctx, dump, e.Config.MaxTotalBytes)
	if err != nil {
		return nil, err
	}
	dumpInfo.Path = "database.dump"
	journalInfo, err := hashFileContext(ctx, filepath.Join(root, "receipts.sqlite"), e.Config.MaxTotalBytes)
	if err != nil {
		return nil, err
	}
	journalInfo.Path = "receipts.sqlite"
	if dumpInfo.Bytes+journalInfo.Bytes > e.Config.MaxTotalBytes {
		return nil, ErrInvalid
	}
	if e.Config.ExpectedJournalAuthority != "" && guard.summary.Authority != e.Config.ExpectedJournalAuthority {
		return nil, ErrIntegrity
	}
	manifest := &Manifest{Format: 1, ID: uuid.NewString(), Scope: e.Config.Scope, Schema: e.Config.Schema, SourceDatabase: e.Config.ExpectedDatabase, CreatedAt: time.Now().UTC(), Consistency: "metadata-share-locks-and-stopped-sdk", Dump: dumpInfo, JournalFile: journalInfo, JournalSummary: guard.summary, Resources: resources, Tables: tables}
	manifest.ConfigFile, err = e.sealConfiguration(root, manifest)
	if err != nil {
		return nil, err
	}
	totalBytes := dumpInfo.Bytes + journalInfo.Bytes + manifest.ConfigFile.Bytes
	for _, resource := range resources {
		totalBytes += resource.Size
	}
	if totalBytes > e.Config.MaxTotalBytes {
		return nil, ErrInvalid
	}
	// Confirm the stopped-SDK guard survived the entire snapshot interval before
	// publishing a complete manifest. A crashed guard leaves an incomplete bundle.
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	if err = guard.close(); err != nil {
		return nil, err
	}
	if err = writeExclusiveJSON(filepath.Join(root, "manifest.json"), manifest); err != nil {
		return nil, err
	}
	info, err := hashFile(filepath.Join(root, "manifest.json"))
	if err != nil {
		return nil, err
	}
	manifestBytes, err := os.ReadFile(filepath.Join(root, "manifest.json"))
	if err != nil {
		return nil, err
	}
	if err = writeExclusiveJSON(filepath.Join(root, "manifest.sha256.json"), manifestChecksum{File: info, Authentication: authenticateManifest(e.Config.BackupEncryptionKey, manifestBytes)}); err != nil {
		return nil, err
	}
	for _, directory := range []string{filepath.Join(root, "objects"), root, filepath.Dir(root)} {
		if err = syncDirectory(directory); err != nil {
			return nil, err
		}
	}
	return manifest, nil
}

func (e *Engine) verifyLocal(ctx context.Context, root string) (*Manifest, error) {
	manifest, err := loadManifest(root)
	if err != nil {
		return nil, err
	}
	checksumPath, err := archivePath(root, "manifest.sha256.json")
	if err != nil {
		return nil, err
	}
	checksumFile, err := os.Open(checksumPath)
	if err != nil {
		return nil, err
	}
	var checksum manifestChecksum
	checksumErr := json.NewDecoder(io.LimitReader(checksumFile, 4096)).Decode(&checksum)
	_ = checksumFile.Close()
	actualManifest, hashErr := hashFile(filepath.Join(root, "manifest.json"))
	manifestBytes, readErr := os.ReadFile(filepath.Join(root, "manifest.json"))
	if checksumErr != nil || hashErr != nil || readErr != nil || checksum.SHA256 != actualManifest.SHA256 || checksum.Bytes != actualManifest.Bytes || !digest.MatchString(checksum.Authentication) || !hmac.Equal([]byte(checksum.Authentication), []byte(authenticateManifest(e.Config.BackupEncryptionKey, manifestBytes))) {
		return nil, ErrIntegrity
	}
	if manifest.Scope != e.Config.Scope || manifest.Schema != e.Config.Schema || len(manifest.Resources) > e.Config.MaxObjects || (e.Config.ExpectedJournalAuthority != "" && manifest.JournalSummary.Authority != e.Config.ExpectedJournalAuthority) {
		return nil, ErrInvalid
	}
	for _, component := range []File{manifest.Dump, manifest.JournalFile, manifest.ConfigFile} {
		if component.Bytes < 1 || component.Bytes > e.Config.MaxTotalBytes || !digest.MatchString(component.SHA256) {
			return nil, ErrInvalid
		}
		path, pathErr := archivePath(root, component.Path)
		if pathErr != nil {
			return nil, pathErr
		}
		actual, hashErr := hashFileContext(ctx, path, component.Bytes)
		if hashErr != nil || actual.Bytes != component.Bytes || actual.SHA256 != component.SHA256 {
			return nil, ErrIntegrity
		}
	}
	if manifest.Dump.Path != "database.dump" || manifest.JournalFile.Path != "receipts.sqlite" {
		return nil, ErrInvalid
	}
	if _, err = e.unsealConfiguration(root, manifest); err != nil {
		return nil, err
	}
	total := manifest.Dump.Bytes + manifest.JournalFile.Bytes + manifest.ConfigFile.Bytes
	seen := map[string]bool{}
	for _, resource := range manifest.Resources {
		total += resource.Size
		if seen[resource.Key] || total > e.Config.MaxTotalBytes {
			return nil, ErrInvalid
		}
		seen[resource.Key] = true
		if err = verifyArchived(ctx, root, resource); err != nil {
			return nil, err
		}
	}
	summary, err := verifyJournal(ctx, e.Config, filepath.Join(root, manifest.JournalFile.Path))
	if err != nil || summary != manifest.JournalSummary {
		return nil, ErrIntegrity
	}
	return manifest, nil
}

// Verify is read-only for PostgreSQL, Redis, S3 and the backup. It verifies local
// components plus every currently canonical remote resource, never just HEAD.
func (e *Engine) Verify(ctx context.Context, root string) (*Manifest, error) {
	ctx, cancel, err := e.bounded(ctx)
	if err != nil {
		return nil, err
	}
	defer cancel()
	if err := e.validate(ctx); err != nil {
		return nil, err
	}
	manifest, err := e.verifyLocal(ctx, root)
	if err != nil {
		return nil, err
	}
	tx, err := e.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	current, err := e.resources(ctx, tx)
	if err != nil {
		return nil, err
	}
	if string(mustJSON(current)) != string(mustJSON(manifest.Resources)) {
		return nil, ErrIntegrity
	}
	for _, resource := range current {
		if err = verifyObject(ctx, e.Objects, resource, nil); err != nil {
			return nil, err
		}
	}
	return manifest, nil
}

func (e *Engine) mutationGuard(ctx context.Context, scope, database string) error {
	if !e.Config.AllowMutations {
		return ErrMutationDisabled
	}
	if scope != e.Config.Scope || database != e.Config.ExpectedDatabase {
		return ErrInvalid
	}
	return e.validate(ctx)
}
func missingObject(err error) bool { return errors.Is(err, objectstore.ErrNotFound) }
