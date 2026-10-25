package main

import (
	"github.com/liveagent/agent-gateway/internal/config"
	"testing"
)

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
