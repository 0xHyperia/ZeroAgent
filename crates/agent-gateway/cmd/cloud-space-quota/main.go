// cloud-space-quota is an operator command, never a browser or model API.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/liveagent/agent-gateway/internal/account"
)

func execute(args []string) error {
	f := flag.NewFlagSet("cloud-space-quota", flag.ContinueOnError)
	user := f.Int64("user", 0, "USA-Zero account ID")
	apply := f.Bool("apply", false, "explicitly apply all supplied limits; default is read-only")
	total := f.Int64("total-bytes", 0, "combined original and artifact reservation limit")
	files := f.Int64("file-bytes", 0, "original reservation limit")
	artifacts := f.Int64("artifact-bytes", 0, "artifact reservation limit")
	maxFiles := f.Int("max-files", 0, "original count limit")
	maxVersions := f.Int("max-artifact-versions", 0, "artifact version count limit")
	if f.Parse(args) != nil || f.NArg() != 0 || *user <= 0 || (!*apply && f.NFlag() != 1) || os.Getenv("DATABASE_URL") == "" {
		return account.ErrCloudFileInvalid
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	db, err := sql.Open("postgres", os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	if err = db.PingContext(ctx); err != nil {
		return err
	}
	if *apply {
		p := account.CloudSpaceLimits{TotalBytes: *total, FileBytes: *files, ArtifactBytes: *artifacts, MaxFiles: *maxFiles, MaxArtifactVersions: *maxVersions}
		if err = account.ConfigureCloudSpaceLimits(ctx, db, *user, p); err != nil {
			return err
		}
	}
	p, err := account.ReadCloudSpaceLimits(ctx, db, *user)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(struct {
		User    int64                    `json:"user"`
		Applied bool                     `json:"applied"`
		Limits  account.CloudSpaceLimits `json:"limits"`
	}{*user, *apply, p})
}
func main() {
	if err := execute(os.Args[1:]); err != nil {
		if errors.Is(err, account.ErrCloudFileInvalid) {
			fmt.Fprintln(os.Stderr, "cloud_space_quota_invalid_arguments")
		} else {
			fmt.Fprintln(os.Stderr, "cloud_space_quota_unconfirmed_read_to_reconcile")
		}
		os.Exit(1)
	}
}
