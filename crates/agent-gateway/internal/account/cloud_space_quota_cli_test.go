package account

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestCloudSpaceQuotaOperatorCLI(t *testing.T) {
	s := cloudRunPostgresFixture(t).store.(*PersistentStore)
	var schema string
	if err := s.db.QueryRow("SELECT current_schema()").Scan(&schema); err != nil {
		t.Fatal(err)
	}
	dsn, err := url.Parse(os.Getenv("ZEROAGENT_CLOUD_RUN_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal("invalid explicit test DSN")
	}
	params := dsn.Query()
	params.Set("search_path", schema)
	dsn.RawQuery = params.Encode()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	invoke := func(args ...string) ([]byte, error) {
		command := exec.CommandContext(ctx, "go", append([]string{"run", "../../cmd/cloud-space-quota"}, args...)...)
		for _, entry := range os.Environ() {
			if !strings.HasPrefix(entry, "DATABASE_URL=") {
				command.Env = append(command.Env, entry)
			}
		}
		command.Env = append(command.Env, "DATABASE_URL="+dsn.String())
		return command.Output()
	}
	data, err := invoke("--user", "1")
	if err != nil {
		t.Fatal("read-only quota CLI failed", err)
	}
	var result struct {
		User    int64
		Applied bool
		Limits  CloudSpaceLimits
	}
	if json.Unmarshal(data, &result) != nil || result.Applied || result.User != 1 || result.Limits.TotalBytes != CloudSpaceDefaultBytes {
		t.Fatal("unexpected read-only quota result")
	}
	var count int
	if err = s.db.QueryRow("SELECT count(*) FROM zeroagent_cloud_space_limits").Scan(&count); err != nil || count != 0 {
		t.Fatal("read-only command wrote configuration", err)
	}
	data, err = invoke("--user", "1", "--apply", "--total-bytes", "1073741824", "--file-bytes", "1073741824", "--artifact-bytes", "1073741824", "--max-files", "2000", "--max-artifact-versions", "3000")
	if err != nil || json.Unmarshal(data, &result) != nil || !result.Applied || result.Limits.MaxFiles != 2000 || result.Limits.MaxArtifactVersions != 3000 {
		t.Fatal("explicit quota configuration failed", err)
	}
	if _, err = invoke("--user", "1", "--total-bytes", "1"); err == nil {
		t.Fatal("write arguments accepted without apply")
	}
	if _, err = invoke("--user", "1", "--apply", "--total-bytes", "1"); err == nil {
		t.Fatal("partial quota configuration accepted")
	}
	p, err := ReadCloudSpaceLimits(ctx, s.db, 1)
	if err != nil || p.TotalBytes != 1<<30 || p.MaxFiles != 2000 {
		t.Fatal("rejected commands changed quota", err)
	}
}
