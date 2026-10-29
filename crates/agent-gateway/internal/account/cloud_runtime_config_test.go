package account

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestCloudRuntimeConfigOperatorLimitsAndStartupFreeze(t *testing.T) {
	for _, name := range []string{"ZEROAGENT_CLOUD_RUN_WORKERS", "ZEROAGENT_CLOUD_RUN_TIMEOUT_SECONDS", "ZEROAGENT_CLOUD_MODEL_MAX_ROUNDS", "ZEROAGENT_CLOUD_TOOL_MAX_CALLS", "ZEROAGENT_CLOUD_ACCOUNT_MAX_EXECUTING", "ZEROAGENT_CLOUD_ACCOUNT_MAX_QUEUED", "ZEROAGENT_CLOUD_EVENT_MAX_STREAMS", "ZEROAGENT_CLOUD_EVENT_MAX_STREAMS_PER_ACCOUNT"} {
		t.Setenv(name, "")
	}
	defaults, err := CloudRuntimeConfigFromEnv()
	if err != nil || defaults != DefaultCloudRuntimeConfig() {
		t.Fatal("default operator limits changed")
	}
	t.Setenv("ZEROAGENT_CLOUD_RUN_WORKERS", "3")
	t.Setenv("ZEROAGENT_CLOUD_RUN_TIMEOUT_SECONDS", "780")
	t.Setenv("ZEROAGENT_CLOUD_MODEL_MAX_ROUNDS", "9")
	t.Setenv("ZEROAGENT_CLOUD_TOOL_MAX_CALLS", "17")
	config, err := CloudRuntimeConfigFromEnv()
	expected := DefaultCloudRuntimeConfig()
	expected.WorkerCount = 3
	expected.RunTimeout = 13 * time.Minute
	expected.MaxModelRounds = 9
	expected.MaxToolCalls = 17
	if err != nil || config != expected {
		t.Fatal("explicit operator configuration not applied")
	}
	s := NewService(NewMemoryStore(), nil, time.Hour, time.Minute)
	if err := s.SetCloudRuntimeConfig(config); err != nil {
		t.Fatal(err)
	}
	if err := s.StartCloudRuns(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.CloseCloudRuns)
	if err := s.SetCloudRuntimeConfig(CloudRuntimeConfig{WorkerCount: 1}); err == nil || s.CloudRuntimeConfig() != config {
		t.Fatal("running workers allowed inconsistent runtime reconfiguration")
	}
}

func TestCloudRuntimeConfigRejectsInvalidBoundsWithoutEchoingValues(t *testing.T) {
	for _, name := range []string{"ZEROAGENT_CLOUD_RUN_WORKERS", "ZEROAGENT_CLOUD_RUN_TIMEOUT_SECONDS", "ZEROAGENT_CLOUD_MODEL_MAX_ROUNDS", "ZEROAGENT_CLOUD_TOOL_MAX_CALLS", "ZEROAGENT_CLOUD_ACCOUNT_MAX_EXECUTING", "ZEROAGENT_CLOUD_ACCOUNT_MAX_QUEUED", "ZEROAGENT_CLOUD_EVENT_MAX_STREAMS", "ZEROAGENT_CLOUD_EVENT_MAX_STREAMS_PER_ACCOUNT"} {
		t.Setenv(name, "")
	}
	for _, test := range []struct{ name, value string }{
		{"ZEROAGENT_CLOUD_RUN_WORKERS", "0"},
		{"ZEROAGENT_CLOUD_RUN_WORKERS", "17"},
		{"ZEROAGENT_CLOUD_RUN_TIMEOUT_SECONDS", "29"},
		{"ZEROAGENT_CLOUD_RUN_TIMEOUT_SECONDS", "3601"},
		{"ZEROAGENT_CLOUD_MODEL_MAX_ROUNDS", "1"},
		{"ZEROAGENT_CLOUD_MODEL_MAX_ROUNDS", "33"},
		{"ZEROAGENT_CLOUD_TOOL_MAX_CALLS", "49"},
		{"ZEROAGENT_CLOUD_TOOL_MAX_CALLS", "not-an-integer-private-value"},
		{"ZEROAGENT_CLOUD_ACCOUNT_MAX_EXECUTING", "9"},
		{"ZEROAGENT_CLOUD_ACCOUNT_MAX_QUEUED", "201"},
		{"ZEROAGENT_CLOUD_EVENT_MAX_STREAMS", "0"},
		{"ZEROAGENT_CLOUD_EVENT_MAX_STREAMS", "1025"},
		{"ZEROAGENT_CLOUD_EVENT_MAX_STREAMS_PER_ACCOUNT", "33"},
	} {
		t.Run(test.name+"/"+test.value, func(t *testing.T) {
			t.Setenv(test.name, test.value)
			_, err := CloudRuntimeConfigFromEnv()
			if err == nil || !strings.Contains(err.Error(), test.name) || strings.Contains(err.Error(), "private-value") {
				t.Fatal("invalid operator limits were accepted or their input was exposed")
			}
		})
	}
}
