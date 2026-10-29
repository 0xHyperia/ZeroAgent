package account

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// CloudRuntimeConfig bounds the Go-owned scheduler and model/tool loop. These
// are operator limits, never parameters accepted from a browser or the model.
// Increasing the Run deadline does not renew an E2B workspace or its budget.
type CloudRuntimeConfig struct {
	WorkerCount               int
	RunTimeout                time.Duration
	MaxModelRounds            int
	MaxToolCalls              int
	MaxExecutingPerAccount    int
	MaxQueuedPerAccount       int
	AdmissionConfigured       bool
	MaxEventStreams           int
	MaxEventStreamsPerAccount int
}

func DefaultCloudRuntimeConfig() CloudRuntimeConfig {
	return CloudRuntimeConfig{WorkerCount: 2, RunTimeout: 15 * time.Minute, MaxModelRounds: 12, MaxToolCalls: 32, MaxExecutingPerAccount: 1, MaxQueuedPerAccount: 20, MaxEventStreams: 128, MaxEventStreamsPerAccount: 8}
}

func normalizeCloudRuntimeConfig(config CloudRuntimeConfig) (CloudRuntimeConfig, error) {
	defaults := DefaultCloudRuntimeConfig()
	if config.WorkerCount == 0 {
		config.WorkerCount = defaults.WorkerCount
	}
	if config.RunTimeout == 0 {
		config.RunTimeout = defaults.RunTimeout
	}
	if config.MaxModelRounds == 0 {
		config.MaxModelRounds = defaults.MaxModelRounds
	}
	if config.MaxToolCalls == 0 {
		config.MaxToolCalls = defaults.MaxToolCalls
	}
	if config.MaxExecutingPerAccount == 0 {
		config.MaxExecutingPerAccount = defaults.MaxExecutingPerAccount
	}
	if config.MaxQueuedPerAccount == 0 {
		config.MaxQueuedPerAccount = defaults.MaxQueuedPerAccount
	}
	if config.MaxEventStreams == 0 {
		config.MaxEventStreams = defaults.MaxEventStreams
	}
	if config.MaxEventStreamsPerAccount == 0 {
		config.MaxEventStreamsPerAccount = min(defaults.MaxEventStreamsPerAccount, config.MaxEventStreams)
	}
	if config.WorkerCount < 1 || config.WorkerCount > 16 || config.RunTimeout < 30*time.Second || config.RunTimeout > time.Hour || config.MaxModelRounds < 2 || config.MaxModelRounds > 32 || config.MaxToolCalls < 1 || config.MaxToolCalls > 48 {
		return CloudRuntimeConfig{}, errors.New("cloud runtime limits are outside supported bounds")
	}
	if config.MaxExecutingPerAccount < 1 || config.MaxExecutingPerAccount > 8 || config.MaxQueuedPerAccount < 1 || config.MaxQueuedPerAccount > 200 {
		return CloudRuntimeConfig{}, errors.New("cloud account admission limits are outside supported bounds")
	}
	if config.MaxEventStreams < 1 || config.MaxEventStreams > 1024 || config.MaxEventStreamsPerAccount < 1 || config.MaxEventStreamsPerAccount > 32 || config.MaxEventStreamsPerAccount > config.MaxEventStreams {
		return CloudRuntimeConfig{}, errors.New("cloud event stream limits are outside supported bounds")
	}
	return config, nil
}

func CloudRuntimeConfigFromEnv() (CloudRuntimeConfig, error) {
	config := DefaultCloudRuntimeConfig()
	for _, setting := range []struct {
		name    string
		minimum int
		maximum int
		apply   func(int)
	}{
		{"ZEROAGENT_CLOUD_RUN_WORKERS", 1, 16, func(n int) { config.WorkerCount = n }},
		{"ZEROAGENT_CLOUD_RUN_TIMEOUT_SECONDS", 30, 3600, func(n int) { config.RunTimeout = time.Duration(n) * time.Second }},
		{"ZEROAGENT_CLOUD_MODEL_MAX_ROUNDS", 2, 32, func(n int) { config.MaxModelRounds = n }},
		{"ZEROAGENT_CLOUD_TOOL_MAX_CALLS", 1, 48, func(n int) { config.MaxToolCalls = n }},
		{"ZEROAGENT_CLOUD_ACCOUNT_MAX_EXECUTING", 1, 8, func(n int) { config.MaxExecutingPerAccount = n }},
		{"ZEROAGENT_CLOUD_ACCOUNT_MAX_QUEUED", 1, 200, func(n int) { config.MaxQueuedPerAccount = n }},
		{"ZEROAGENT_CLOUD_EVENT_MAX_STREAMS", 1, 1024, func(n int) { config.MaxEventStreams = n }},
		{"ZEROAGENT_CLOUD_EVENT_MAX_STREAMS_PER_ACCOUNT", 1, 32, func(n int) { config.MaxEventStreamsPerAccount = n }},
	} {
		value := strings.TrimSpace(os.Getenv(setting.name))
		if value == "" {
			continue
		}
		n, err := strconv.Atoi(value)
		if err != nil || n < setting.minimum || n > setting.maximum {
			return CloudRuntimeConfig{}, fmt.Errorf("%s must be an integer in %d..%d", setting.name, setting.minimum, setting.maximum)
		}
		setting.apply(n)
		if setting.name == "ZEROAGENT_CLOUD_ACCOUNT_MAX_EXECUTING" || setting.name == "ZEROAGENT_CLOUD_ACCOUNT_MAX_QUEUED" {
			config.AdmissionConfigured = true
		}
	}
	if strings.TrimSpace(os.Getenv("ZEROAGENT_CLOUD_EVENT_MAX_STREAMS_PER_ACCOUNT")) == "" {
		config.MaxEventStreamsPerAccount = min(config.MaxEventStreamsPerAccount, config.MaxEventStreams)
	}
	return normalizeCloudRuntimeConfig(config)
}

// SetCloudRuntimeConfig is startup-only: every worker of a runtime uses the same
// immutable snapshot. Reconfiguration requires a clean process restart.
func (s *Service) SetCloudRuntimeConfig(config CloudRuntimeConfig) error {
	config, err := normalizeCloudRuntimeConfig(config)
	if err != nil {
		return err
	}
	s.cloudRuntimeMu.Lock()
	defer s.cloudRuntimeMu.Unlock()
	if s.cloudRuntime != nil {
		return errors.New("cloud runtime configuration cannot change after startup")
	}
	s.cloudRuntimeConfig = config
	return nil
}

func (s *Service) CloudRuntimeConfig() CloudRuntimeConfig {
	s.cloudRuntimeMu.Lock()
	defer s.cloudRuntimeMu.Unlock()
	config, _ := normalizeCloudRuntimeConfig(s.cloudRuntimeConfig)
	return config
}
