package cloudbackup

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/liveagent/agent-gateway/internal/account"
)

// Fixed application namespaces, audited against the actual account store.
// Never FLUSHDB, zeroagent:*, caller-selected patterns, or other service keys.
var authPrefixes = []string{"zeroagent:web-session:", "zeroagent:cloud-session-ref:", "zeroagent:session-refresh:", "zeroagent:session-revocation:", "zeroagent:session-refresh-lock:", "zeroagent:desktop-handoff:", "zeroagent:oauth-transaction:", "zeroagent:device-presence:", "zeroagent:selection-lease:"}

func (e *Engine) invalidateSQL(ctx context.Context, tx *sql.Tx) error {
	if err := account.ReconcileCloudPresentationForRestore(ctx, tx, e.Config.Schema); err != nil {
		return fmt.Errorf("restore_public_presentation_failed")
	}
	schema := `"` + e.Config.Schema + `".`
	statements := []string{
		`UPDATE ` + schema + `agents SET revoked_at=COALESCE(revoked_at,clock_timestamp()),token_sha256=repeat('0',64)`,
		`UPDATE ` + schema + `zerobox_devices SET revoked_at=COALESCE(revoked_at,clock_timestamp()),credential_hash=repeat('0',64)`,
		// The display snapshot is durable user data. Restoring credentials cannot
		// resume an old executor, and an unfinished tool may already have had an
		// external effect. Close only unfinished display intervals as unknown;
		// preserve completed outcomes, text, usage and original per-block times.
		`UPDATE ` + schema + `zeroagent_cloud_runs r SET presentation=
 r.presentation || jsonb_build_object('state','interrupted','completed_at',transaction_timestamp(),
 'blocks',COALESCE((SELECT jsonb_agg(
  CASE WHEN b.value->>'completed_at' IS NOT NULL THEN b.value
   WHEN b.value->>'type'='tool' THEN b.value || jsonb_build_object('completed_at',transaction_timestamp(),'state','unknown','status','结果待确认')
   ELSE b.value || jsonb_build_object('completed_at',transaction_timestamp()) END ORDER BY b.ordinal)
  FROM jsonb_array_elements(r.presentation->'blocks') WITH ORDINALITY b(value,ordinal)),'[]'::jsonb),
 'rounds',COALESCE((SELECT jsonb_agg(
  CASE WHEN v.value->>'completed_at' IS NOT NULL THEN v.value ELSE v.value || jsonb_build_object('completed_at',transaction_timestamp()) END ORDER BY v.ordinal)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.presentation->'rounds')='array' THEN r.presentation->'rounds' ELSE '[]'::jsonb END) WITH ORDINALITY v(value,ordinal)),'[]'::jsonb))
 WHERE r.state IN ('queued','running','cancelling') AND r.presentation->>'version'='1' AND jsonb_typeof(r.presentation->'blocks')='array'`,
		// A restored source clock can be ahead of this host. Append retained partials
		// after canonical history, with deterministic distinct timestamps even if an
		// old/abnormal snapshot contains multiple active runs in one conversation.
		`WITH pending AS MATERIALIZED (
 SELECT r.*,row_number() OVER(PARTITION BY r.user_id,r.conversation_id ORDER BY r.created_at,r.id) AS ordinal
 FROM ` + schema + `zeroagent_cloud_runs r
 WHERE r.state IN ('queued','running','cancelling') AND (r.output<>'' OR (r.presentation->>'version'='1' AND CASE WHEN jsonb_typeof(r.presentation->'blocks')='array' THEN jsonb_array_length(r.presentation->'blocks')>0 ELSE false END))
 AND NOT EXISTS(SELECT 1 FROM ` + schema + `zerobox_cloud_messages m WHERE m.id=r.assistant_message_id)
), latest AS (
 SELECT p.user_id,p.conversation_id,max(m.created_at) AS created_at
 FROM (SELECT DISTINCT user_id,conversation_id FROM pending) p
 LEFT JOIN ` + schema + `zerobox_cloud_messages m ON m.user_id=p.user_id AND m.conversation_id=p.conversation_id
 GROUP BY p.user_id,p.conversation_id
), recovery_clock AS MATERIALIZED (SELECT clock_timestamp() AS created_at)
INSERT INTO ` + schema + `zerobox_cloud_messages(id,conversation_id,user_id,role,content,usage,created_at,presentation)
SELECT p.assistant_message_id,p.conversation_id,p.user_id,'assistant',to_jsonb(p.output),p.usage,
 GREATEST(c.created_at,COALESCE(l.created_at+interval '1 microsecond',c.created_at))+(p.ordinal-1)*interval '1 microsecond',p.presentation
FROM pending p JOIN latest l USING(user_id,conversation_id) CROSS JOIN recovery_clock c
ON CONFLICT(id) DO NOTHING`,
		`INSERT INTO ` + schema + `zeroagent_cloud_run_events(id,run_id,user_id,seq,type,payload,created_at) SELECT gen_random_uuid(),id,user_id,last_seq+1,'run.interrupted',jsonb_build_object('state','interrupted','error_code','restore_auth_invalidated','started_at',created_at,'completed_at',transaction_timestamp()),clock_timestamp() FROM ` + schema + `zeroagent_cloud_runs WHERE state IN ('queued','running','cancelling')`,
		`UPDATE ` + schema + `zeroagent_cloud_runs SET state='interrupted',error_code='restore_auth_invalidated',lease_owner='',lease_until=NULL,last_seq=last_seq+1,updated_at=clock_timestamp() WHERE state IN ('queued','running','cancelling')`,
		`UPDATE ` + schema + `zeroagent_cloud_tool_operations SET state='unknown',error_code='restore_auth_invalidated',version=version+1,updated_at=clock_timestamp() WHERE state IN ('prepared','executing')`,
		`UPDATE ` + schema + `zeroagent_cloud_workspaces SET state='cleanup_pending',version=version+1,updated_at=clock_timestamp() WHERE state NOT IN ('closed','cleanup_pending')`,
		`UPDATE ` + schema + `zeroagent_cloud_workspace_observations SET state='cleanup_pending',version=version+1,updated_at=clock_timestamp() WHERE state NOT IN ('closed','cleanup_pending')`,
		`UPDATE ` + schema + `zeroagent_cloud_files SET state=CASE WHEN state IN ('uploaded','processing') THEN 'failed' ELSE state END,error_code='parse_unknown',parser_task=CASE WHEN jsonb_typeof(parser_task)='object' THEN jsonb_set(parser_task,'{state}','"unknown"'::jsonb) ELSE parser_task END,updated_at=clock_timestamp() WHERE state IN ('uploaded','processing') OR (jsonb_typeof(parser_task)='object' AND parser_task->>'state'='running')`,
	}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("restore_auth_fence_failed")
		}
	}
	return nil
}
func (e *Engine) invalidateRedis(ctx context.Context) error {
	if e.Redis == nil {
		return ErrInvalid
	}
	deleted := 0
	for _, prefix := range authPrefixes {
		var cursor uint64
		for {
			keys, next, err := e.Redis.Scan(ctx, cursor, prefix+"*", 100).Result()
			if err != nil {
				return err
			}
			for _, key := range keys {
				if !strings.HasPrefix(key, prefix) {
					return ErrInvalid
				}
			}
			deleted += len(keys)
			if deleted > 1000000 {
				return ErrInvalid
			}
			if len(keys) > 0 {
				if err = e.Redis.Del(ctx, keys...).Err(); err != nil {
					return err
				}
			}
			cursor = next
			if cursor == 0 {
				break
			}
		}
	}
	// No application process may write auth state during restoration. A second
	// observation fails rather than claiming a live namespace was invalidated.
	for _, prefix := range authPrefixes {
		var cursor uint64
		for {
			keys, next, err := e.Redis.Scan(ctx, cursor, prefix+"*", 100).Result()
			if err != nil {
				return err
			}
			if len(keys) > 0 {
				return ErrIntegrity
			}
			cursor = next
			if cursor == 0 {
				break
			}
		}
	}
	return nil
}

// InvalidateAuthentication is deliberately separate and explicit for recovery
// drills. It is also a mandatory step of Restore, before successful admission.
func (e *Engine) InvalidateAuthentication(ctx context.Context, scope, database string) error {
	ctx, cancel, err := e.bounded(ctx)
	if err != nil {
		return err
	}
	defer cancel()
	if err := e.mutationGuard(ctx, scope, database); err != nil {
		return err
	}
	tx, err := e.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `SET LOCAL lock_timeout='5s'`); err != nil {
		return err
	}
	if _, err = e.tableFacts(ctx, tx, true); err != nil {
		return err
	}
	if err = e.invalidateSQL(ctx, tx); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	// SQL and Redis cannot commit atomically. On any Redis error the restore
	// remains incomplete/offline; repeating this invalidation is idempotent.
	return e.invalidateRedis(ctx)
}
