// cloudchat-backup defaults to read-only verification. Connection credentials
// are read only from the explicitly selected private JSON file, never argv.
package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	_ "github.com/lib/pq"
	"github.com/liveagent/agent-gateway/internal/cloudbackup"
	"github.com/liveagent/agent-gateway/internal/objectstore"
	"github.com/redis/go-redis/v9"
)

type privateConfig struct {
	DatabaseURL           string `json:"database_url"`
	ExpectedDatabase      string `json:"expected_database"`
	Schema                string `json:"schema"`
	Scope                 string `json:"scope"`
	RedisURL              string `json:"redis_url"`
	ObjectEndpoint        string `json:"object_endpoint"`
	ObjectBucket          string `json:"object_bucket"`
	ObjectRegion          string `json:"object_region"`
	ObjectAccessKey       string `json:"object_access_key"`
	ObjectSecretKey       string `json:"object_secret_key"`
	AllowLoopbackHTTP     bool   `json:"allow_loopback_http"`
	PGDump                string `json:"pg_dump"`
	PGRestore             string `json:"pg_restore"`
	Node                  string `json:"node"`
	JournalHelper         string `json:"journal_helper"`
	JournalDirectory      string `json:"journal_directory"`
	JournalAuthority      string `json:"journal_authority"`
	ProtectedConfigSource string `json:"protected_config_source"`
	RestoredConfigPath    string `json:"restored_config_path"`
	BackupEncryptionKey   string `json:"backup_encryption_key_base64"`
	AllowMutations        bool   `json:"allow_mutations"`
	TimeoutSeconds        int    `json:"timeout_seconds"`
	MaxObjects            int    `json:"max_objects"`
	MaxTotalBytes         int64  `json:"max_total_bytes"`
}

func execute() error {
	args := os.Args[1:]
	mode := "verify"
	if len(args) > 0 && len(args[0]) > 0 && args[0][0] != '-' {
		mode = args[0]
		args = args[1:]
	}
	options := flag.NewFlagSet("cloudchat-backup", flag.ContinueOnError)
	bundle := options.String("bundle", "", "absolute private backup directory")
	scope := options.String("scope", "", "explicit target deployment scope for restore/invalidate")
	database := options.String("database", "", "explicit fresh target database name for restore/invalidate")
	report := options.String("report", "", "new private restoration phase report path")
	if err := options.Parse(args); err != nil {
		return cloudbackup.ErrInvalid
	}
	if options.NArg() != 0 {
		return cloudbackup.ErrInvalid
	}
	if mode != "verify" && mode != "create" && mode != "restore" && mode != "invalidate-auth" {
		return cloudbackup.ErrInvalid
	}
	path := os.Getenv("ZEROAGENT_CLOUD_BACKUP_CONFIG")
	if path == "" {
		return cloudbackup.ErrInvalid
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 64<<10 || (runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0) {
		return cloudbackup.ErrInvalid
	}
	source, err := os.Open(path)
	if err != nil {
		return cloudbackup.ErrInvalid
	}
	defer func() { _ = source.Close() }()
	decoder := json.NewDecoder(io.LimitReader(source, 64<<10))
	decoder.DisallowUnknownFields()
	var config privateConfig
	if decoder.Decode(&config) != nil || decoder.Decode(&struct{}{}) != io.EOF || len(config.JournalAuthority) != 64 {
		return cloudbackup.ErrInvalid
	}
	backupKey, keyErr := base64.StdEncoding.DecodeString(config.BackupEncryptionKey)
	if keyErr != nil || len(backupKey) != 32 {
		return cloudbackup.ErrInvalid
	}
	// The candidate restore path is validated on POSIX with native pg_dump tools;
	// no shell bridging, WSL path rewriting, remote SQL or process auto-start.
	if (mode == "restore" || mode == "invalidate-auth") && runtime.GOOS == "windows" {
		return cloudbackup.ErrInvalid
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	db, err := sql.Open("postgres", config.DatabaseURL)
	if err != nil {
		return cloudbackup.ErrInvalid
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(4)
	objects, err := cloudbackup.NewS3(objectstore.Config{Endpoint: config.ObjectEndpoint, Bucket: config.ObjectBucket, Region: config.ObjectRegion, AccessKeyID: config.ObjectAccessKey, SecretAccessKey: config.ObjectSecretKey, AllowLoopbackHTTP: config.AllowLoopbackHTTP})
	if err != nil {
		return err
	}
	defer objects.Close()
	redisOptions, err := redis.ParseURL(config.RedisURL)
	if err != nil {
		return cloudbackup.ErrInvalid
	}
	cache := redis.NewClient(redisOptions)
	defer func() { _ = cache.Close() }()
	engine := &cloudbackup.Engine{DB: db, Redis: cache, Objects: objects, Config: cloudbackup.Config{DatabaseURL: config.DatabaseURL, ExpectedDatabase: config.ExpectedDatabase, Schema: config.Schema, Scope: config.Scope, PGDumpPath: config.PGDump, PGRestorePath: config.PGRestore, NodePath: config.Node, JournalHelperPath: config.JournalHelper, JournalDirectory: config.JournalDirectory, ExpectedJournalAuthority: config.JournalAuthority, ProtectedConfigSource: config.ProtectedConfigSource, RestoredConfigPath: config.RestoredConfigPath, BackupEncryptionKey: backupKey, AllowMutations: config.AllowMutations, MaxObjects: config.MaxObjects, MaxTotalBytes: config.MaxTotalBytes, Timeout: time.Duration(config.TimeoutSeconds) * time.Second}}
	switch mode {
	case "verify":
		_, err = engine.Verify(ctx, *bundle)
	case "create":
		_, err = engine.Create(ctx, *bundle)
	case "restore":
		_, err = engine.Restore(ctx, *bundle, *scope, *database, *report)
	case "invalidate-auth":
		err = engine.InvalidateAuthentication(ctx, *scope, *database)
	}
	if err == nil {
		_, err = fmt.Fprintln(os.Stdout, "cloudchat_backup_"+mode+"_complete")
	}
	return err
}
func main() {
	if err := execute(); err != nil {
		code := "operation_failed"
		switch {
		case errors.Is(err, cloudbackup.ErrInvalid):
			code = "invalid_scope_or_config"
		case errors.Is(err, cloudbackup.ErrIntegrity):
			code = "integrity_verification_failed"
		case errors.Is(err, cloudbackup.ErrTargetNotEmpty):
			code = "target_not_empty"
		case errors.Is(err, cloudbackup.ErrMutationDisabled):
			code = "mutation_not_authorized"
		case errors.Is(err, cloudbackup.ErrConditionalWritesUnsupported):
			code = "conditional_writes_unsupported"
		case errors.Is(err, cloudbackup.ErrConditionalWritesUnconfirmed):
			code = "conditional_writes_unconfirmed"
		}
		fmt.Fprintln(os.Stderr, "cloudchat_backup_"+code)
		var probe *cloudbackup.ConditionalWriteError
		if errors.As(err, &probe) {
			if encoded, jsonErr := json.Marshal(probe.Probe); jsonErr == nil {
				fmt.Fprintln(os.Stderr, string(encoded))
			}
		}
		os.Exit(1)
	}
}
