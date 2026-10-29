// Package cloudbackup builds maintenance-window candidates, not online backups.
// It never loads application profiles or runs a restore without explicit scope.
package cloudbackup

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"time"

	"github.com/liveagent/agent-gateway/internal/objectstore"
	"github.com/redis/go-redis/v9"
)

var (
	ErrInvalid                      = errors.New("invalid backup scope or manifest")
	ErrIntegrity                    = errors.New("backup resource integrity mismatch")
	ErrTargetNotEmpty               = errors.New("restore target is not empty")
	ErrMutationDisabled             = errors.New("restore or authentication invalidation requires explicit authorization")
	ErrWriteUnknown                 = errors.New("restore object write outcome is unknown")
	ErrConditionalWritesUnsupported = errors.New("restore conditional writes are unsupported")
	ErrConditionalWritesUnconfirmed = errors.New("restore conditional writes are unconfirmed")
)

type Config struct {
	DatabaseURL              string
	ExpectedDatabase         string
	Schema                   string
	Scope                    string
	PGDumpPath               string
	PGRestorePath            string
	NodePath                 string
	JournalHelperPath        string
	JournalDirectory         string
	ExpectedJournalAuthority string
	ProtectedConfigSource    string
	RestoredConfigPath       string
	BackupEncryptionKey      []byte
	AllowMutations           bool
	MaxObjects               int
	MaxTotalBytes            int64
	Timeout                  time.Duration
}

type ConditionalObjects interface {
	objectstore.Store
	CheckRestoreWriteSemantics(context.Context) error
	PutIfAbsent(context.Context, string, io.ReadSeeker, int64, objectstore.PutOptions) error
}

// ConditionalWriteProbe contains only a random probe key and fixed safe codes.
// It never contains endpoint URLs, credentials, SDK error text, or account data.
type ConditionalWriteProbe struct {
	Code             string `json:"code"`
	ProbeKey         string `json:"probe_key,omitempty"`
	CleanupRequired  bool   `json:"cleanup_required"`
	CleanupConfirmed bool   `json:"cleanup_confirmed"`
	CleanupCode      string `json:"cleanup_code"`
	ObservedPayload  string `json:"observed_payload,omitempty"`
}

type ConditionalWriteError struct {
	Probe          ConditionalWriteProbe
	classification error
}

func (e *ConditionalWriteError) Error() string { return e.Probe.Code }
func (e *ConditionalWriteError) Unwrap() error { return e.classification }

type Engine struct {
	Config  Config
	DB      *sql.DB
	Redis   *redis.Client
	Objects ConditionalObjects
}

type Resource struct {
	Kind     string            `json:"kind"`
	ID       string            `json:"id"`
	FamilyID string            `json:"family_id,omitempty"`
	UserID   int64             `json:"user_id"`
	Key      string            `json:"key"`
	Size     int64             `json:"size"`
	SHA256   string            `json:"sha256"`
	MIME     string            `json:"mime"`
	Metadata map[string]string `json:"metadata"`
	Archive  string            `json:"archive"`
}
type File struct {
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}
type Journal struct {
	Authority      string `json:"authority"`
	ReceiptCount   int64  `json:"receipt_count"`
	UnknownCount   int64  `json:"unknown_count"`
	ExecutingCount int64  `json:"executing_count"`
	LogicalSHA256  string `json:"logical_sha256"`
}
type Manifest struct {
	Format         int        `json:"format"`
	ID             string     `json:"id"`
	Scope          string     `json:"scope"`
	Schema         string     `json:"schema"`
	SourceDatabase string     `json:"source_database"`
	CreatedAt      time.Time  `json:"created_at"`
	Consistency    string     `json:"consistency"`
	Dump           File       `json:"database"`
	JournalFile    File       `json:"journal"`
	ConfigFile     File       `json:"protected_configuration"`
	JournalSummary Journal    `json:"journal_summary"`
	Resources      []Resource `json:"resources"`
	Tables         []Table    `json:"tables"`
}
type Table struct {
	Name string `json:"name"`
	Rows int64  `json:"rows"`
}
type RestoreReport struct {
	CandidateID            string                 `json:"candidate_id"`
	Scope                  string                 `json:"scope"`
	Database               string                 `json:"database"`
	Phase                  string                 `json:"phase"`
	Complete               bool                   `json:"complete"`
	AuthInvalidated        bool                   `json:"auth_invalidated"`
	UpdatedAt              time.Time              `json:"updated_at"`
	Failure                string                 `json:"failure,omitempty"`
	WriteSemanticsVerified bool                   `json:"write_semantics_verified"`
	WriteProbe             *ConditionalWriteProbe `json:"write_probe,omitempty"`
}
