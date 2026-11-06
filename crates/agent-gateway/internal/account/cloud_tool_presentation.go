package account

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/lib/pq"
)

const cloudPresentationMaxResources = 16

// A display reference is an immutable identity, not a download URL, grant,
// sandbox path or execution capability. Opening it must recheck current access.
type CloudPresentationResource struct {
	Kind     string `json:"kind"`
	ID       string `json:"id"`
	Name     string `json:"name"`
	MIME     string `json:"mime,omitempty"`
	FamilyID string `json:"family_id,omitempty"`
	Version  int64  `json:"version,omitempty"`
	Role     string `json:"role"`
}

type cloudToolResourceSelector struct {
	kind, id, role string
	byOperation    bool
}

func cloudPublicToolRound(op *CloudToolOperation) (int, bool) {
	if op == nil || cloudPublicToolStatus(op.Name) == "" {
		return 0, false
	}
	parts := strings.Split(op.CallKey, ":")
	if len(parts) != 4 || parts[0] != "round" || parts[2] != "call" {
		return 0, false
	}
	round, err := strconv.Atoi(parts[1])
	index, indexErr := strconv.Atoi(parts[3])
	return round, err == nil && indexErr == nil && round >= 0 && round <= 1024 && index >= 0
}

func cloudToolResourceSelection(op *CloudToolOperation) *cloudToolResourceSelector {
	if op.State != CloudToolSucceeded {
		// A verified ready artifact or persisted source is a real result even
		// when the parent tool's final receipt was lost. Keep its unknown state.
		if op.State != CloudToolExecuting && op.State != CloudToolUnknown {
			return nil
		}
		switch op.Name {
		case "publish_artifact", "publish_site", "generate_image", "web_search", "fetch_page":
		default:
			return nil
		}
	}
	switch op.Name {
	case "publish_artifact", "publish_site", "generate_image":
		return &cloudToolResourceSelector{kind: "artifact", id: op.ID, role: "output", byOperation: true}
	case "web_search", "fetch_page":
		return &cloudToolResourceSelector{kind: "source", id: op.ID, role: "source", byOperation: true}
	case "read_source":
		var input struct {
			ID string `json:"source_id"`
		}
		if json.Unmarshal(op.Input, &input) == nil && siteIdentity(input.ID) {
			return &cloudToolResourceSelector{kind: "source", id: input.ID, role: "source"}
		}
	case "load_uploaded_file":
		var input struct {
			FileID     string `json:"file_id"`
			ArtifactID string `json:"artifact_version_id"`
		}
		var result struct {
			File struct {
				FileID     string `json:"file_id"`
				ArtifactID string `json:"artifact_version_id"`
			} `json:"file"`
		}
		if json.Unmarshal(op.Input, &input) != nil || json.Unmarshal(op.Result, &result) != nil {
			return nil
		}
		if siteIdentity(input.FileID) && input.ArtifactID == "" && result.File.FileID == input.FileID && result.File.ArtifactID == "" {
			return &cloudToolResourceSelector{kind: "file", id: input.FileID, role: "input"}
		}
		if siteIdentity(input.ArtifactID) && input.FileID == "" && result.File.ArtifactID == input.ArtifactID && result.File.FileID == "" {
			return &cloudToolResourceSelector{kind: "artifact", id: input.ArtifactID, role: "input"}
		}
	}
	return nil
}

func cloudPublicResourceName(name string) string {
	name = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, name))
	runes := []rune(name)
	if len(runes) > 240 {
		name = string(runes[:239]) + "…"
	}
	if name == "" {
		return "未命名资料"
	}
	return name
}

func cloudCanonicalResource(kind, id, name, mime, family string, version int64, role string) CloudPresentationResource {
	return CloudPresentationResource{Kind: kind, ID: id, Name: cloudPublicResourceName(name), MIME: mime, FamilyID: family, Version: version, Role: role}
}

func cloudExtensionDraftResources(op *CloudToolOperation) []CloudPresentationResource {
	if op.Name != prepareExtensionTool || op.State != CloudToolSucceeded {
		return nil
	}
	var draft struct {
		Revision struct{ Name string } `json:"revision"`
	}
	if json.Unmarshal(op.Result, &draft) != nil || !cloudSkillName.MatchString(draft.Revision.Name) {
		return nil
	}
	return []CloudPresentationResource{
		cloudCanonicalResource("extension-draft", op.ID, draft.Revision.Name, "", "", 0, "output"),
	}
}

// Called under the account store mutex. Metadata comes from owned canonical
// records, never names/URLs returned by the model or a sandbox process.
func (s *MemoryStore) cloudToolResourcesLocked(op *CloudToolOperation) []CloudPresentationResource {
	if op.Name == prepareExtensionTool {
		return cloudExtensionDraftResources(op)
	}
	selector := cloudToolResourceSelection(op)
	if selector == nil {
		return nil
	}
	items := []CloudPresentationResource{}
	switch selector.kind {
	case "artifact":
		if s.cloudArtifacts == nil {
			return nil
		}
		id := selector.id
		if selector.byOperation {
			id = s.cloudArtifacts.operations[id]
		}
		a, exists := s.cloudArtifacts.versions[id]
		if !exists || a.UserID != op.UserID || a.State != CloudArtifactReady || a.DeletedAt != nil {
			return nil
		}
		if selector.byOperation && (a.ToolOperationID != op.ID || a.SourceRunID != op.RunID) {
			return nil
		}
		kind := "artifact"
		if s.cloudSites != nil {
			if site, ok := s.cloudSites.releases[a.ID]; ok && site.UserID == op.UserID && site.SiteID == a.FamilyID && site.SHA256 == a.SHA256 {
				kind = "site"
			}
		}
		items = append(items, cloudCanonicalResource(kind, a.ID, a.Name, a.MIME, a.FamilyID, a.Number, selector.role))
	case "file":
		f, exists := s.cloudFiles[selector.id]
		if exists && f.UserID == op.UserID && f.DeletedAt == nil && f.State != CloudFileDeleting && f.State != CloudFileDeleted && f.UploadedAt != nil {
			items = append(items, cloudCanonicalResource("file", f.ID, f.Name, f.MIME, "", 0, selector.role))
		}
	case "source":
		if s.cloudResearchSources == nil {
			return nil
		}
		for _, source := range s.cloudResearchSources.sources {
			matches := source.ID == selector.id
			if selector.byOperation {
				matches = source.ToolOperationID == selector.id
			}
			if matches && source.UserID == op.UserID && (source.RunID == op.RunID || op.Name == "read_source" && op.State == CloudToolSucceeded && !selector.byOperation) && source.DeletedAt == nil {
				items = append(items, cloudCanonicalResource("source", source.ID, source.Title, "text/plain", "", source.Version, selector.role))
			}
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	if len(items) > cloudPresentationMaxResources {
		items = items[:cloudPresentationMaxResources]
	}
	return items
}

// Narrow SQL reads avoid loading original file bytes, page bodies or manifests.
func cloudToolResourcesTx(ctx context.Context, tx *sql.Tx, op *CloudToolOperation) ([]CloudPresentationResource, error) {
	if op.Name == prepareExtensionTool {
		return cloudExtensionDraftResources(op), nil
	}
	selector := cloudToolResourceSelection(op)
	if selector == nil {
		return nil, nil
	}
	var rows *sql.Rows
	var err error
	switch selector.kind {
	case "artifact":
		where := "a.id=$2"
		if selector.byOperation {
			where = "a.tool_operation_id=$2 AND a.source_run_id=$3"
		}
		args := []any{op.UserID, selector.id}
		if selector.byOperation {
			args = append(args, op.RunID)
		}
		rows, err = tx.QueryContext(ctx, `SELECT CASE WHEN EXISTS(SELECT 1 FROM zeroagent_cloud_site_releases r WHERE r.id=a.id AND r.user_id=a.user_id AND r.site_id=a.family_id AND r.sha256=a.sha256) THEN 'site' ELSE 'artifact' END,a.id::text,a.name,a.mime,a.family_id::text,a.number FROM zeroagent_cloud_artifact_versions a WHERE a.user_id=$1 AND `+where+` AND a.state='ready' AND a.deleted_at IS NULL`, args...)
	case "file":
		rows, err = tx.QueryContext(ctx, `SELECT 'file',id::text,name,mime,''::text,0::bigint FROM zeroagent_cloud_files WHERE user_id=$1 AND id=$2 AND uploaded_at IS NOT NULL AND deleted_at IS NULL AND state NOT IN ('deleting','deleted')`, op.UserID, selector.id)
	case "source":
		where := "id=$2"
		if selector.byOperation {
			where = "tool_operation_id=$2"
		}
		// A successful read_source receipt has already passed the executor's
		// selected-history guard; publication/unknown receipts remain Run-bound.
		rows, err = tx.QueryContext(ctx, `SELECT 'source',id::text,title,'text/plain',''::text,version FROM zeroagent_cloud_research_sources WHERE user_id=$1 AND `+where+` AND (run_id=$3 OR $4) AND deleted_at IS NULL ORDER BY id LIMIT 16`, op.UserID, selector.id, op.RunID, op.Name == "read_source" && op.State == CloudToolSucceeded && !selector.byOperation)
	}
	if err != nil {
		return nil, err
	}
	if rows == nil {
		return nil, nil
	}
	defer rows.Close()
	items := []CloudPresentationResource{}
	for rows.Next() {
		var item CloudPresentationResource
		if err = rows.Scan(&item.Kind, &item.ID, &item.Name, &item.MIME, &item.FamilyID, &item.Version); err != nil {
			return nil, err
		}
		item.Name, item.Role = cloudPublicResourceName(item.Name), selector.role
		items = append(items, item)
	}
	return items, rows.Err()
}

func cloudToolPresentationOperationID(op *CloudToolOperation) string {
	return fmt.Sprintf("tool-result:%s:%d", op.ID, op.Version)
}

func prepareCloudToolPresentation(run *CloudRun, op *CloudToolOperation, resources []CloudPresentationResource, now time.Time) (*CloudRunCommit, string, error) {
	round, public := cloudPublicToolRound(op)
	if !public {
		return nil, "", nil
	}
	state := op.State
	if state == CloudToolSucceeded {
		state = "completed"
	}
	commit, hash, err := prepareCloudRunCommit(CloudRunCommit{
		OperationID: cloudToolPresentationOperationID(op), EventType: "tool." + state,
		Payload:               cloudJSON(map[string]any{"tool_id": op.ID, "name": op.Name, "round": round, "resources": resources, "status": cloudImageFailureStatus(op)}),
		presentationResources: resources,
	})
	if err != nil {
		return nil, "", err
	}
	if err = applyCloudPresentation(run, &commit, now); err != nil {
		return nil, "", err
	}
	return &commit, hash, nil
}

func reconcileCloudToolPresentation(run *CloudRun, op CloudToolOperation, resources []CloudPresentationResource, now time.Time) (*CloudRunCommit, error) {
	if _, public := cloudPublicToolRound(&op); !public {
		return nil, nil
	}
	unfinished := op.State == CloudToolPrepared || op.State == CloudToolExecuting
	if unfinished {
		op.State = CloudToolUnknown
	}
	presentation, err := cloudPresentation(run)
	if err != nil {
		return nil, err
	}
	for _, block := range presentation.Blocks {
		if block.ToolID != op.ID {
			continue
		}
		if unfinished && block.State != CloudToolPrepared && block.State != CloudToolExecuting {
			op.State = block.State // Never rewrite a previously confirmed outcome.
		}
		if block.State == op.State && block.CompletedAt != nil && (len(resources) == 0 || string(cloudJSON(resources)) == string(cloudJSON(block.Resources))) {
			return nil, nil
		}
		break
	}
	projected := *run
	if !projected.Terminal() {
		projected.State = CloudRunInterrupted
	} // Restore finalization uses the reserved display budget too.
	commit, _, err := prepareCloudToolPresentation(&projected, &op, resources, now)
	if err == nil {
		run.Presentation = projected.Presentation
	}
	if commit != nil {
		commit.OperationID = fmt.Sprintf("tool-reconcile:%s:%d", op.ID, op.Version)
	}
	return commit, err
}

// Reconciliation never calls tools. It closes the earlier crash window between
// durable artifact/source publication and receipt commit, retaining unknown
// execution status and only verifiable account-owned result identities.
func (s *MemoryStore) reconcileCloudToolsLocked(run *CloudRun, now time.Time) error {
	if s.cloudTools == nil {
		return nil
	}
	ops := []CloudToolOperation{}
	for _, op := range s.cloudTools.operations {
		if op.UserID == run.UserID && op.RunID == run.ID {
			ops = append(ops, op)
		}
	}
	sort.Slice(ops, func(i, j int) bool {
		return cloudProjectEarlier(ops[i].CreatedAt, ops[i].ID, ops[j].CreatedAt, ops[j].ID)
	})
	updates := []CloudRunCommit{}
	for _, op := range ops {
		commit, err := reconcileCloudToolPresentation(run, op, s.cloudToolResourcesLocked(&op), now)
		if err != nil {
			return err
		}
		if commit != nil {
			updates = append(updates, *commit)
		}
	}
	for _, commit := range updates {
		s.appendCloudRunEventLocked(run, commit.EventType, commit.Payload, now)
	}
	return nil
}

func reconcileCloudToolsTx(ctx context.Context, tx *sql.Tx, run *CloudRun, now time.Time) error {
	// Some embedded installations do not enable cloud tools. No new schema is
	// required there, and ordinary conversation finalization must keep working.
	var enabled bool
	if err := tx.QueryRowContext(ctx, `SELECT to_regclass('zeroagent_cloud_tool_operations') IS NOT NULL`).Scan(&enabled); err != nil {
		return err
	}
	if !enabled {
		return nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT id::text,user_id,run_id::text,call_key,name,state,version,created_at,updated_at,error_code,
CASE name WHEN 'read_source' THEN jsonb_build_object('source_id',input->'source_id') WHEN 'load_uploaded_file' THEN jsonb_build_object('file_id',input->'file_id','artifact_version_id',input->'artifact_version_id') ELSE NULL END,
CASE name WHEN 'load_uploaded_file' THEN jsonb_build_object('file',jsonb_build_object('file_id',result->'file'->'file_id','artifact_version_id',result->'file'->'artifact_version_id')) ELSE NULL END
FROM zeroagent_cloud_tool_operations WHERE user_id=$1 AND run_id=$2 ORDER BY created_at,id LIMIT 128`, run.UserID, run.ID)
	if err != nil {
		return err
	}
	ops := []CloudToolOperation{}
	for rows.Next() {
		var op CloudToolOperation
		var input, result []byte
		if err = rows.Scan(&op.ID, &op.UserID, &op.RunID, &op.CallKey, &op.Name, &op.State, &op.Version, &op.CreatedAt, &op.UpdatedAt, &op.ErrorCode, &input, &result); err != nil {
			rows.Close()
			return err
		}
		op.Input, op.Result = input, result
		ops = append(ops, op)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, op := range ops {
		if _, public := cloudPublicToolRound(&op); !public {
			continue
		}
		resources, err := cloudToolResourcesTx(ctx, tx, &op)
		if err != nil {
			return err
		}
		commit, err := reconcileCloudToolPresentation(run, op, resources, now)
		if err != nil {
			return err
		}
		if commit != nil {
			if err = appendCloudRunDBEvent(ctx, tx, run, commit.EventType, commit.Payload, "", "", now); err != nil {
				return err
			}
		}
	}
	return nil
}

// ReconcileCloudPresentationForRestore is used only inside the backup engine's
// maintenance transaction, before its authentication fence creates partial
// messages. It does not claim/resume execution or change run lifecycle state.
func ReconcileCloudPresentationForRestore(ctx context.Context, tx *sql.Tx, schema string) error {
	var previous string
	if err := tx.QueryRowContext(ctx, `SELECT current_setting('search_path')`).Scan(&previous); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `SELECT set_config('search_path',$1,true)`, pq.QuoteIdentifier(schema)); err != nil {
		return err
	}
	var now time.Time
	if err := tx.QueryRowContext(ctx, `SELECT transaction_timestamp()`).Scan(&now); err != nil {
		return err
	}
	after := ""
	for {
		// One bounded display snapshot at a time; never read the private request.
		columns := strings.Replace(cloudRunColumns, "r.request_content", "NULL", 1)
		rows, err := tx.QueryContext(ctx, "SELECT "+columns+` FROM zeroagent_cloud_runs r WHERE r.state IN ('queued','running','cancelling') AND ($1='' OR r.id::text>$1) ORDER BY r.id LIMIT 1 FOR UPDATE`, after)
		if err != nil {
			return err
		}
		runs := []*CloudRun{}
		for rows.Next() {
			run, err := scanCloudRun(rows)
			if err != nil {
				rows.Close()
				return err
			}
			runs = append(runs, run)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		for _, run := range runs {
			if err = reconcileCloudToolsTx(ctx, tx, run, now); err != nil {
				return err
			}
			after = run.ID
		}
		if len(runs) == 0 {
			break
		}
	}
	_, err := tx.ExecContext(ctx, `SELECT set_config('search_path',$1,true)`, previous)
	return err
}
