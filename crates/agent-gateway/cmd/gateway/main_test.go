package main

import (
	"github.com/liveagent/agent-gateway/internal/config"
	"strings"
	"testing"
)

func TestCloudFileParserConfigurationDefaultsAndExplicitControl(t *testing.T) {
	for _, test := range []struct {
		name, value string
		want        bool
	}{
		{"unset", "", true}, {"blank", "  ", true},
		{"enabled", "true", true}, {"disabled", "false", false},
		{"trimmed", " false\n", false}, {"numeric off", "0", false},
		{"numeric on", "1", true}, {"uppercase", "FALSE", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			enabled, err := cloudFileParserEnabled(func(name string) string {
				if name != "ZEROAGENT_CLOUD_FILE_PARSER_ENABLED" {
					t.Fatalf("unexpected environment dependency: %s", name)
				}
				return test.value
			})
			if err != nil || enabled != test.want {
				t.Fatalf("parser enabled=%v err=%v, expected %v", enabled, err, test.want)
			}
		})
	}
}

func TestCloudFileParserConfigurationRejectsInvalidValuesWithoutEnablingOrEchoing(t *testing.T) {
	for _, value := range []string{"yes", "2", "false true", "accidentally-pasted-private-value"} {
		enabled, err := cloudFileParserEnabled(func(string) string { return value })
		if enabled || err == nil || !strings.Contains(err.Error(), "ZEROAGENT_CLOUD_FILE_PARSER_ENABLED") || strings.Contains(err.Error(), value) {
			t.Fatal("invalid parser setting must fail closed with a value-free configuration error")
		}
	}
}

func TestManagedDesktopCannotEnableAnUnownedOrPublicListener(t *testing.T) {
	valid := config.Config{HTTPAddr: "127.0.0.1:50052", Token: "opaque", InstanceNonce: "launch"}
	if err := validateManagedDesktop(&valid); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*config.Config){
		func(c *config.Config) { c.HTTPAddr = "0.0.0.0:50052" },
		func(c *config.Config) { c.HTTPAddr = "localhost:50052" },
		func(c *config.Config) { c.Token = "" },
		func(c *config.Config) { c.InstanceNonce = "" },
		func(c *config.Config) { c.TLSCert = "unexpected" },
	} {
		candidate := valid
		change(&candidate)
		if validateManagedDesktop(&candidate) == nil {
			t.Fatal("unsafe desktop listener accepted")
		}
	}
}
