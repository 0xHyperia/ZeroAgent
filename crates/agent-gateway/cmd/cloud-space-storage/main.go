// cloud-space-storage is an explicit, bounded storage initializer. It never
// rewrites the application's config, deletes objects or reads ambient AWS keys.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/liveagent/agent-gateway/internal/cloudbackup"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

func execute(args []string) error {
	flags := flag.NewFlagSet("cloud-space-storage", flag.ContinueOnError)
	create := flags.Bool("create-bucket", false, "explicitly initialize only the configured bucket")
	conditional := flags.Bool("verify-conditional-writes", false, "verify restore write semantics using owned disposable probe objects")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return objectstore.ErrInvalidInput
	}
	config, err := objectstore.ConfigFromEnv(os.Getenv)
	if err != nil {
		return err
	}
	store, err := objectstore.New(config)
	if err != nil {
		return err
	}
	defer store.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	if *create {
		err = store.InitializeBucket(ctx)
	} else {
		err = store.Ready(ctx)
	}
	if err != nil {
		return err
	}
	if *conditional {
		backup, err := cloudbackup.NewS3(config)
		if err != nil {
			return err
		}
		defer backup.Close()
		if err = backup.CheckRestoreWriteSemantics(ctx); err != nil {
			return err
		}
	}
	fmt.Fprintln(os.Stdout, "cloud_space_storage_ready")
	return nil
}

func main() {
	if err := execute(os.Args[1:]); err != nil {
		code := "unavailable"
		switch {
		case errors.Is(err, objectstore.ErrDisabled), errors.Is(err, objectstore.ErrInvalidConfig), errors.Is(err, objectstore.ErrInvalidInput):
			code = "invalid_config_or_arguments"
		case errors.Is(err, objectstore.ErrAccessDenied):
			code = "access_denied"
		case errors.Is(err, objectstore.ErrNotFound):
			code = "bucket_not_initialized"
		case errors.Is(err, cloudbackup.ErrConditionalWritesUnsupported), errors.Is(err, cloudbackup.ErrConditionalWritesUnconfirmed):
			code = "conditional_write_verification_failed"
		}
		fmt.Fprintln(os.Stderr, "cloud_space_storage_"+code)
		os.Exit(1)
	}
}
