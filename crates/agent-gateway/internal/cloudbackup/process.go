package cloudbackup

import (
	"context"
	"encoding/json"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func pgEnvironment(databaseURL, schema string) ([]string, error) {
	parsed, err := url.Parse(databaseURL)
	if err != nil || parsed.User == nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") || parsed.Hostname() == "" {
		return nil, ErrInvalid
	}
	env := []string{}
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "PG") {
			env = append(env, value)
		}
	}
	password, _ := parsed.User.Password()
	env = append(env, "PGHOST="+parsed.Hostname(), "PGPORT="+parsed.Port(), "PGUSER="+parsed.User.Username(), "PGPASSWORD="+password, "PGDATABASE="+strings.TrimPrefix(parsed.Path, "/"), "PGCONNECT_TIMEOUT=5", "PGOPTIONS=-c search_path="+schema)
	for query, key := range map[string]string{"sslmode": "PGSSLMODE", "sslrootcert": "PGSSLROOTCERT", "sslcert": "PGSSLCERT", "sslkey": "PGSSLKEY"} {
		if value := parsed.Query().Get(query); value != "" {
			env = append(env, key+"="+value)
		}
	}
	return env, nil
}
func runPG(ctx context.Context, cfg Config, restore bool, args ...string) error {
	binary := cfg.PGDumpPath
	if restore {
		binary = cfg.PGRestorePath
	}
	if !filepath.IsAbs(binary) || regular(binary) != nil {
		return ErrInvalid
	}
	env, err := pgEnvironment(cfg.DatabaseURL, cfg.Schema)
	if err != nil {
		return err
	}
	command := exec.CommandContext(ctx, binary, args...)
	command.Env = env
	command.WaitDelay = time.Second
	// Diagnostics can include SQL data/DSNs; callers get a fixed phase failure.
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if command.Run() != nil {
		return ErrIntegrity
	}
	return nil
}

type journalGuard struct {
	process *exec.Cmd
	input   io.WriteCloser
	summary Journal
}

func startJournalGuard(ctx context.Context, cfg Config, target string) (*journalGuard, error) {
	if !filepath.IsAbs(cfg.NodePath) || !filepath.IsAbs(cfg.JournalHelperPath) || regular(cfg.NodePath) != nil || regular(cfg.JournalHelperPath) != nil {
		return nil, ErrInvalid
	}
	process := exec.CommandContext(ctx, cfg.NodePath, cfg.JournalHelperPath, "guard-snapshot", cfg.JournalDirectory, target)
	process.WaitDelay = time.Second
	input, err := process.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := process.StdoutPipe()
	if err != nil {
		return nil, err
	}
	process.Stderr = io.Discard
	if err = process.Start(); err != nil {
		return nil, err
	}
	var summary Journal
	if err = json.NewDecoder(io.LimitReader(output, 1<<20)).Decode(&summary); err != nil {
		_ = input.Close()
		_ = process.Wait()
		return nil, ErrIntegrity
	}
	return &journalGuard{process: process, input: input, summary: summary}, nil
}
func (g *journalGuard) close() error {
	if g.process == nil {
		return nil
	}
	_ = g.input.Close()
	process := g.process
	g.process = nil
	if process.Wait() != nil {
		return ErrIntegrity
	}
	return nil
}
func verifyJournal(ctx context.Context, cfg Config, path string) (Journal, error) {
	process := exec.CommandContext(ctx, cfg.NodePath, cfg.JournalHelperPath, "verify", path)
	process.WaitDelay = time.Second
	output, err := process.Output()
	if err != nil || len(output) > 1<<20 {
		return Journal{}, ErrIntegrity
	}
	var summary Journal
	if json.Unmarshal(output, &summary) != nil || !digest.MatchString(summary.Authority) || !digest.MatchString(summary.LogicalSHA256) {
		return Journal{}, ErrIntegrity
	}
	return summary, nil
}
