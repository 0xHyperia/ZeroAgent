package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/liveagent/agent-gateway/internal/account"
	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
	"github.com/liveagent/agent-gateway/internal/cloudresearch"
	"github.com/liveagent/agent-gateway/internal/cloudsite"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/objectstore"
	"github.com/liveagent/agent-gateway/internal/observability"
	"github.com/liveagent/agent-gateway/internal/server"
	"github.com/liveagent/agent-gateway/internal/session"
)

// fatal 记录错误并以非零码退出（slog 没有 Fatal 级别，集中在此处理）。
func fatal(msg string, args ...any) {
	slog.Error(msg, args...)
	os.Exit(1)
}

func validateManagedDesktop(cfg *config.Config) error {
	host, _, err := net.SplitHostPort(cfg.HTTPAddr)
	ip := net.ParseIP(host)
	if err != nil || ip == nil || !ip.IsLoopback() || cfg.InstanceNonce == "" || cfg.Token == "" || cfg.TLSCert != "" || cfg.TLSKey != "" {
		return fmt.Errorf("desktop-owned Gateway requires an authenticated plain HTTP numeric loopback listener and launch nonce")
	}
	return nil
}

func main() {
	observability.SetupLogging()
	cfg := config.Load()
	managedDesktop := os.Getenv("ZEROAGENT_GATEWAY_DESKTOP_PARENT") == "1"
	if managedDesktop {
		if err := validateManagedDesktop(cfg); err != nil {
			fatal("invalid local Gateway configuration", "err", err)
		}
	}
	//nolint:staticcheck // 读取弃用字段正是为了对旧启动脚本发出弃用警告。
	if cfg.GRPCAddr != "" {
		slog.Warn("-grpc-addr is deprecated and ignored: the v1 gRPC listener was removed; desktop clients connect via /ws/v2/agent on the HTTP port")
	}
	sm := session.NewManager()
	usaClient, err := account.NewUSAClient(cfg.USAZeroOrigin, cfg.USAZeroAuthorizationOrigin, cfg.RequestTimeout, cfg.OAuthWebClientSecret)
	if err != nil {
		fatal("invalid USA-Zero configuration", "err", err)
	}
	var accountStore account.Store = account.NewMemoryStore()
	var closeAccountStore func() error
	var readinessCheck func(context.Context) error
	if !managedDesktop && (cfg.DatabaseURL != "" || cfg.RedisURL != "") {
		startupCtx, startupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		persistentStore, storeErr := account.OpenPersistentStore(startupCtx, cfg.DatabaseURL, cfg.RedisURL)
		startupCancel()
		if storeErr != nil {
			// URL/driver errors can contain the complete configured DSN, including
			// its password. Do not forward them to process/container logs.
			fatal("account storage startup failed; verify PostgreSQL/Redis configuration, availability and permissions")
		}
		accountStore = persistentStore
		closeAccountStore = persistentStore.Close
		readinessCheck = persistentStore.Ready
		slog.Info("account storage enabled", "postgres", true, "redis", true)
	} else if !managedDesktop {
		slog.Warn("DATABASE_URL and REDIS_URL are not configured; account sessions and devices use in-memory development storage")
	}
	accountService := account.NewService(accountStore, usaClient, cfg.WebSessionTTL, cfg.SelectionLeaseTTL)
	runContext, stopRuns := context.WithCancel(context.Background())
	defer stopRuns()
	var waitMaintenance func()
	var siteConfig *cloudsite.Config
	if !managedDesktop {
		runtimeConfig, runtimeConfigErr := account.CloudRuntimeConfigFromEnv()
		if runtimeConfigErr != nil {
			fatal("invalid cloud runtime configuration", "err", runtimeConfigErr)
		}
		if err := accountService.SetCloudRuntimeConfig(runtimeConfig); err != nil {
			fatal("cloud runtime configuration failed", "err", err)
		}
		objectConfig, configErr := objectstore.ConfigFromEnv(os.Getenv)
		if configErr != nil {
			fatal("invalid cloud object storage configuration", "err", configErr)
		}
		objects, objectErr := objectstore.New(objectConfig)
		if objectErr != nil {
			fatal("invalid cloud object storage configuration", "err", objectErr)
		}
		defer objects.Close()
		if objects.Status().Enabled {
			if err := accountService.SetCloudObjectStore(objects); err != nil {
				fatal("cloud file service startup failed", "err", err)
			}
			slog.Info("cloud object storage configured")
			previousCheck := readinessCheck
			readinessCheck = func(ctx context.Context) error {
				if previousCheck != nil {
					if err := previousCheck(ctx); err != nil {
						return err
					}
				}
				return objects.Ready(ctx)
			}
		} else {
			slog.Info("cloud object storage disabled", "missing", objects.Status().Missing)
		}
		siteConfig, err = cloudsite.ConfigFromEnv(os.Getenv, cfg.PublicOrigin)
		if err != nil {
			fatal("invalid isolated site hosting configuration")
		}
		if err := accountService.SetCloudSiteConfig(siteConfig); err != nil {
			fatal("site hosting startup failed")
		}
		executorURL := strings.TrimSpace(os.Getenv("ZEROAGENT_CLOUD_EXECUTOR_URL"))
		executorToken := os.Getenv("ZEROAGENT_CLOUD_EXECUTOR_TOKEN")
		if executorURL != "" || executorToken != "" {
			if executorURL == "" || executorToken == "" {
				fatal("cloud executor URL and internal token must be configured together")
			}
			executor, executorErr := cloudexecutor.New(cloudexecutor.Config{BaseURL: executorURL, Token: executorToken})
			if executorErr != nil {
				fatal("invalid cloud executor configuration", "err", executorErr)
			}
			defer executor.CloseIdleConnections()
			if err := accountService.SetCloudExecutor(executor); err != nil {
				fatal("cloud executor service startup failed", "err", err)
			}
			if err := accountService.StartCloudFileParser(runContext); err != nil {
				fatal("cloud file parser startup failed", "err", err)
			}
			defer accountService.CloseCloudFileParser()
			previousCheck := readinessCheck
			readinessCheck = func(ctx context.Context) error {
				if previousCheck != nil {
					if err := previousCheck(ctx); err != nil {
						return err
					}
				}
				health, err := executor.Health(ctx)
				if err != nil {
					return err
				}
				if !health.Enabled {
					return errors.New("cloud execution is unavailable")
				}
				if health.Journal != nil && health.Journal.AdmissionAvailable != nil && !*health.Journal.AdmissionAvailable {
					return errors.New("cloud execution journal cannot accept new operations")
				}
				return nil
			}
			slog.Info("cloud execution adapter configured")
		}
		searchConfig, searchConfigErr := cloudresearch.TavilyConfigFromEnv(os.Getenv)
		if searchConfigErr != nil {
			fatal("invalid cloud search configuration")
		}
		search, searchErr := cloudresearch.NewTavily(searchConfig)
		if searchErr != nil {
			fatal("invalid cloud search configuration", "err", searchErr)
		}
		fetchEnabled := search.Status().Enabled
		if value := strings.TrimSpace(os.Getenv("ZEROAGENT_CLOUD_WEB_FETCH_ENABLED")); value != "" {
			fetchEnabled, err = strconv.ParseBool(value)
			if err != nil {
				fatal("invalid cloud web fetch setting")
			}
		}
		var fetch *cloudresearch.Fetcher
		if fetchEnabled {
			fetch, err = cloudresearch.NewFetcher(cloudresearch.FetchConfig{})
			if err != nil {
				fatal("invalid cloud web fetch configuration", "err", err)
			}
		}
		if err := accountService.SetCloudResearch(search, fetch); err != nil {
			fatal("cloud research startup failed", "err", err)
		}
		slog.Info("cloud research configured", "search", search.Status().Enabled, "public_page_fetch", fetchEnabled)
		if err := accountService.StartCloudRuns(runContext); err != nil {
			fatal("cloud task runtime startup failed", "err", err)
		}
		defer accountService.CloseCloudRuns()
		maintenanceDone := make(chan struct{})
		go func() {
			defer close(maintenanceDone)
			ticker := time.NewTicker(time.Minute)
			defer ticker.Stop()
			for {
				select {
				case <-runContext.Done():
					return
				case <-ticker.C:
					cleanupCtx, cancel := context.WithTimeout(runContext, 30*time.Second)
					var err error
					if objects.Status().Enabled {
						err = accountService.ReconcileCloudFiles(cleanupCtx, 50)
					}
					cancel()
					if err != nil && runContext.Err() == nil {
						slog.Warn("cloud file reconciliation incomplete")
					}
				}
			}
		}()
		waitMaintenance = func() { stopRuns(); <-maintenanceDone }
		defer waitMaintenance()
	}

	images := server.NewLocalImageHub(cfg)
	var httpHandler http.Handler
	if managedDesktop {
		httpHandler = server.NewHTTPServerWithLocalImages(cfg, sm, nil, images)
	} else {
		httpHandler = server.NewHTTPServerWithReadiness(cfg, sm, accountService, readinessCheck)
	}
	if closer, ok := httpHandler.(io.Closer); ok {
		defer func() {
			if err := closer.Close(); err != nil {
				slog.Warn("http handler cleanup error", "err", err)
			}
		}()
	}
	httpServer := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           httpHandler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return runContext },
	}

	errCh := make(chan error, 2)
	var siteServer *http.Server
	if siteConfig != nil {
		// This listener has no account router, cookies or object-store endpoint.
		// A separate HTTPS wildcard domain is terminated by the reverse proxy.
		siteServer = &http.Server{Addr: siteConfig.ListenAddr, Handler: accountService.CloudSiteContentHandler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, WriteTimeout: 35 * time.Second, MaxHeaderBytes: 16 << 10, BaseContext: func(net.Listener) context.Context { return runContext }}
		listener, err := net.Listen("tcp", siteConfig.ListenAddr)
		if err != nil {
			fatal("isolated site listener startup failed")
		}
		defer listener.Close()
		go func() {
			if err := siteServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errCh <- errors.New("isolated site listener stopped")
			}
		}()
		slog.Info("isolated site content listener configured")
	}

	go func() {
		slog.Info("HTTP listening", "addr", cfg.HTTPAddr)
		var serveErr error
		if cfg.TLSCert != "" || cfg.TLSKey != "" {
			serveErr = httpServer.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
		} else {
			serveErr = httpServer.ListenAndServe()
		}
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			errCh <- serveErr
		}
	}()

	signalCh := make(chan os.Signal, 1)
	signal.Notify(signalCh, syscall.SIGINT, syscall.SIGTERM)
	var parentClosed <-chan struct{}
	if os.Getenv("ZEROAGENT_GATEWAY_DESKTOP_PARENT") == "1" {
		// The desktop retains the pipe's write handle for its whole lifetime and
		// writes only control lines (Image Studio backend rebinds). EOF also covers
		// force termination and development rebuilds, where no desktop exit
		// callback or Rust destructor can run.
		parentClosed = server.WatchDesktopParent(os.Stdin, images)
	}

	select {
	case <-parentClosed:
		slog.Info("desktop parent exited, shutting down")
	case sig := <-signalCh:
		slog.Info("received signal, shutting down", "signal", sig.String())
	case err := <-errCh:
		fatal("server error", "err", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	stopRuns()
	accountService.CloseCloudRuns()
	accountService.CloseCloudFileParser()
	if waitMaintenance != nil {
		waitMaintenance()
	}

	if err := httpServer.Shutdown(ctx); err != nil {
		slog.Warn("http shutdown error", "err", err)
	}
	if siteServer != nil {
		if err := siteServer.Shutdown(ctx); err != nil {
			slog.Warn("site content shutdown incomplete")
		}
	}
	if closeAccountStore != nil {
		if err := closeAccountStore(); err != nil {
			slog.Warn("account storage close error", "err", err)
		}
	}
}
