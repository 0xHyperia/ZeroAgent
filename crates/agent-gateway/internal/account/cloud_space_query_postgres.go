package account

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"
)

// Changes fence subsequent pages instead of pretending that a live query is an
// immutable snapshot. Rolled-back writes cannot invalidate a cursor. These are
// metadata-only projections; file text, parser journals and object keys stay out.
const cloudSpacePagingSchema = `
CREATE TABLE IF NOT EXISTS zeroagent_cloud_space_revisions(user_id BIGINT PRIMARY KEY CHECK(user_id>0),generation BIGINT NOT NULL CHECK(generation>0));
CREATE OR REPLACE FUNCTION zeroagent_cloud_space_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id BIGINT;
BEGIN
 IF TG_OP='DELETE' THEN owner_id=OLD.user_id; ELSE owner_id=NEW.user_id; END IF;
 INSERT INTO zeroagent_cloud_space_revisions(user_id,generation) VALUES(owner_id,1)
 ON CONFLICT(user_id) DO UPDATE SET generation=zeroagent_cloud_space_revisions.generation+1;
 IF TG_OP='UPDATE' AND OLD.user_id<>NEW.user_id THEN
  INSERT INTO zeroagent_cloud_space_revisions(user_id,generation) VALUES(OLD.user_id,1)
  ON CONFLICT(user_id) DO UPDATE SET generation=zeroagent_cloud_space_revisions.generation+1;
 END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER zeroagent_cloud_space_file_revision AFTER INSERT OR UPDATE OR DELETE ON zeroagent_cloud_files FOR EACH ROW EXECUTE FUNCTION zeroagent_cloud_space_changed();
CREATE OR REPLACE TRIGGER zeroagent_cloud_space_artifact_revision AFTER INSERT OR UPDATE OR DELETE ON zeroagent_cloud_artifact_versions FOR EACH ROW EXECUTE FUNCTION zeroagent_cloud_space_changed();
CREATE OR REPLACE TRIGGER zeroagent_cloud_space_metadata_revision AFTER INSERT OR UPDATE OR DELETE ON zeroagent_cloud_space_metadata FOR EACH ROW EXECUTE FUNCTION zeroagent_cloud_space_changed();
CREATE OR REPLACE TRIGGER zeroagent_cloud_space_limit_revision AFTER INSERT OR UPDATE OR DELETE ON zeroagent_cloud_space_limits FOR EACH ROW EXECUTE FUNCTION zeroagent_cloud_space_changed();
CREATE OR REPLACE TRIGGER zeroagent_cloud_space_site_revision AFTER INSERT OR UPDATE OR DELETE ON zeroagent_cloud_site_releases FOR EACH ROW EXECUTE FUNCTION zeroagent_cloud_space_changed();
CREATE INDEX IF NOT EXISTS zeroagent_cloud_space_family_latest_idx ON zeroagent_cloud_artifact_versions(user_id,family_id,number DESC) WHERE deleted_at IS NULL AND state<>'deleted';
CREATE INDEX IF NOT EXISTS zeroagent_cloud_space_file_usage_idx ON zeroagent_cloud_files(user_id) INCLUDE(size) WHERE state<>'deleted';
CREATE INDEX IF NOT EXISTS zeroagent_cloud_space_artifact_usage_idx ON zeroagent_cloud_artifact_versions(user_id) INCLUDE(size,family_id) WHERE state<>'deleted';`

const spaceProjection = `WITH latest_sites AS (
 SELECT DISTINCT ON(a.family_id) a.family_id,a.id FROM zeroagent_cloud_site_releases r
 JOIN zeroagent_cloud_artifact_versions a ON a.id=r.id AND a.family_id=r.site_id AND a.user_id=r.user_id AND a.sha256=r.sha256
 WHERE r.user_id=$1 AND a.state='ready' AND a.deleted_at IS NULL ORDER BY a.family_id,a.number DESC
), canonical AS (
 SELECT 'file'::text kind,f.id,f.id target_id,f.name,f.mime,f.size,f.state,COALESCE(f.conversation_id::text,'') conversation_id,0::bigint versions,f.created_at,f.updated_at,''::text site_version_id
 FROM zeroagent_cloud_files f WHERE f.user_id=$1 AND f.deleted_at IS NULL AND f.state<>'deleted'
 UNION ALL
 SELECT 'artifact',a.family_id,a.id,a.name,a.mime,a.size,a.state,a.conversation_id::text,a.versions,a.created_at,a.updated_at,
 CASE WHEN a.state='ready' AND a.id<>s.id THEN '' ELSE COALESCE(s.id::text,'') END FROM (
  SELECT DISTINCT ON(family_id) a.id,a.family_id,a.name,a.mime,a.size,a.state,a.conversation_id,a.created_at,a.updated_at,a.number,count(*) OVER(PARTITION BY family_id) versions FROM zeroagent_cloud_artifact_versions a
  WHERE a.user_id=$1 AND a.deleted_at IS NULL AND a.state<>'deleted' ORDER BY family_id,number DESC
 ) a LEFT JOIN latest_sites s ON s.family_id=a.family_id
), items AS (
 SELECT c.kind,c.id,c.target_id,COALESCE(NULLIF(m.name,''),c.name) name,COALESCE(m.folder_id::text,'') folder_id,COALESCE(m.starred,false) starred,COALESCE(m.trashed,false) trashed,COALESCE(m.version,0) version,
 c.created_at,GREATEST(c.updated_at,COALESCE(m.updated_at,c.updated_at)) updated_at,c.mime,c.size,c.state,c.conversation_id,c.versions,1 rank,c.site_version_id
 FROM canonical c LEFT JOIN zeroagent_cloud_space_metadata m ON m.user_id=$1 AND m.kind=c.kind AND m.id=c.id
 UNION ALL
 SELECT m.kind,m.id,m.id,m.name,COALESCE(m.folder_id::text,''),m.starred,m.trashed,m.version,m.created_at,m.updated_at,''::text,0::bigint,'ready'::text,''::text,0::bigint,0,''::text
 FROM zeroagent_cloud_space_metadata m WHERE m.user_id=$1 AND m.kind='folder'
), projected AS (SELECT *,lower(name) COLLATE "C" lower_name FROM items) `
const spaceItemColumns = `id::text,kind,name,folder_id,starred,trashed,version,created_at,updated_at,target_id::text,mime,size,state,conversation_id,versions,lower_name,site_version_id`

func scanSpaceItem(row interface{ Scan(...any) error }) (CloudSpaceItem, error) {
	var item CloudSpaceItem
	err := row.Scan(&item.ID, &item.Kind, &item.Name, &item.FolderID, &item.Starred, &item.Trashed, &item.Version, &item.CreatedAt, &item.UpdatedAt, &item.TargetID, &item.MIME, &item.Size, &item.State, &item.ConversationID, &item.Versions, &item.sortName, &item.SiteVersionID)
	return item, err
}
func spaceWhere(q CloudSpaceQuery) (string, []any) {
	typeCase := "CASE WHEN kind='folder' THEN 'folder' WHEN site_version_id<>'' THEN 'site' "
	for _, rule := range spaceTypeRules {
		typeCase += "WHEN lower(mime) ~ '" + rule.mime + "' OR lower_name ~ '" + rule.name + "' THEN '" + rule.kind + "' "
	}
	typeCase += "ELSE 'code' END"
	return `trashed=$2 AND ($3<>'starred' OR starred) AND ($4='' OR folder_id=$4)
 AND NOT($4='' AND $5='' AND $3='all' AND $6='all' AND $7='' AND $8='' AND folder_id<>'')
 AND ($5='' OR position(lower($5) in lower(name))>0)
 AND ($6<>'uploads' OR kind='file') AND ($6<>'outputs' OR kind='artifact')
 AND ($6<>'images' OR mime LIKE 'image/%') AND ($6<>'documents' OR (kind<>'folder' AND mime NOT LIKE 'image/%'))
 AND ($6<>'sites' OR site_version_id<>'') AND ($6<>'recent' OR kind<>'folder')
 AND ($8<>'uploads' OR kind='file') AND ($8<>'outputs' OR kind='artifact')
 AND ($7='' OR (` + typeCase + `)=$7)`, []any{q.Scope == "trash", q.Scope, q.Folder, q.Query, q.Category, q.Type, q.Origin}
}

type spaceSortKey struct {
	column, direction string
	value             any
}

func spaceSortKeys(q CloudSpaceQuery, cursor *cloudSpaceCursor) []spaceSortKey {
	c := cloudSpaceCursor{}
	if cursor != nil {
		c = *cursor
	}
	rank := 1
	if c.Kind == "folder" {
		rank = 0
	}
	keys := []spaceSortKey{{"rank", "ASC", rank}}
	if q.Sort == "name" {
		keys = append(keys, spaceSortKey{`lower_name COLLATE "C"`, "ASC", c.Name})
	}
	if q.Sort == "size" {
		keys = append(keys, spaceSortKey{"size", "DESC", c.Size})
	}
	return append(keys, spaceSortKey{"updated_at", "DESC", c.Updated}, spaceSortKey{"kind", "ASC", c.Kind}, spaceSortKey{"id", "DESC", c.ID})
}
func querySpaceItems(ctx context.Context, tx *sql.Tx, userID int64, q CloudSpaceQuery, cursor *cloudSpaceCursor, limit int) ([]CloudSpaceItem, error) {
	where, args := spaceWhere(q)
	args = append([]any{userID}, args...)
	keys := spaceSortKeys(q, cursor)
	order := []string{}
	for _, key := range keys {
		order = append(order, key.column+" "+key.direction)
	}
	if cursor != nil {
		clauses, equal := []string{}, []string{}
		for _, key := range keys {
			args = append(args, key.value)
			placeholder := fmt.Sprintf("$%d", len(args))
			op := ">"
			if key.direction == "DESC" {
				op = "<"
			}
			clauses = append(clauses, "("+strings.Join(append(append([]string{}, equal...), key.column+op+placeholder), " AND ")+")")
			equal = append(equal, key.column+"="+placeholder)
		}
		where += " AND (" + strings.Join(clauses, " OR ") + ")"
	}
	args = append(args, limit, q.Offset)
	rows, err := tx.QueryContext(ctx, spaceProjection+"SELECT "+spaceItemColumns+" FROM projected WHERE "+where+" ORDER BY "+strings.Join(order, ",")+fmt.Sprintf(" LIMIT $%d OFFSET $%d", len(args)-1, len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []CloudSpaceItem{}
	for rows.Next() {
		item, err := scanSpaceItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
func readSpaceUsageTx(ctx context.Context, tx *sql.Tx, userID int64) (CloudSpaceUsage, error) {
	p, err := readSpaceLimitsTx(ctx, tx, userID)
	if err != nil {
		return CloudSpaceUsage{}, err
	}
	u := CloudSpaceUsage{LimitBytes: p.TotalBytes, FileLimitBytes: p.FileBytes, ArtifactLimitBytes: p.ArtifactBytes, FileLimitCount: p.MaxFiles, ArtifactLimitCount: p.MaxArtifactVersions}
	err = tx.QueryRowContext(ctx, `SELECT
 COALESCE((SELECT sum(size) FROM zeroagent_cloud_files WHERE user_id=$1 AND state<>'deleted'),0),
 COALESCE((SELECT sum(size) FROM zeroagent_cloud_artifact_versions WHERE user_id=$1 AND state<>'deleted'),0),
 (SELECT count(*) FROM zeroagent_cloud_files WHERE user_id=$1 AND state<>'deleted'),
 (SELECT count(*) FROM zeroagent_cloud_artifact_versions WHERE user_id=$1 AND state<>'deleted'),
 COALESCE((SELECT sum(f.size) FROM zeroagent_cloud_files f JOIN zeroagent_cloud_space_metadata m ON m.user_id=f.user_id AND m.kind='file' AND m.id=f.id AND m.trashed WHERE f.user_id=$1 AND f.state<>'deleted'),0)+
 COALESCE((SELECT sum(a.size) FROM zeroagent_cloud_artifact_versions a JOIN zeroagent_cloud_space_metadata m ON m.user_id=a.user_id AND m.kind='artifact' AND m.id=a.family_id AND m.trashed WHERE a.user_id=$1 AND a.state<>'deleted'),0)`, userID).Scan(&u.FileBytes, &u.ArtifactBytes, &u.FileCount, &u.ArtifactVersionCount, &u.TrashBytes)
	u.UsedBytes = u.FileBytes + u.ArtifactBytes
	return u, err
}
func (s *PersistentStore) QueryCloudSpace(ctx context.Context, userID int64, query CloudSpaceQuery) (*CloudSpacePage, error) {
	q, cursor, err := normalizeSpaceQuery(userID, query)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var generation int64
	if err = tx.QueryRowContext(ctx, `SELECT COALESCE((SELECT generation FROM zeroagent_cloud_space_revisions WHERE user_id=$1),0)`, userID).Scan(&generation); err != nil {
		return nil, err
	}
	revision := strconv.FormatInt(generation, 10)
	if cursor != nil && cursor.Revision != revision {
		return nil, ErrCloudSpacePageChanged
	}
	p := &CloudSpacePage{NextOffset: -1, Folders: []CloudSpaceItem{}}
	where, args := spaceWhere(q)
	if err = tx.QueryRowContext(ctx, spaceProjection+"SELECT count(*) FROM projected WHERE "+where, append([]any{userID}, args...)...).Scan(&p.Total); err != nil {
		return nil, err
	}
	items, err := querySpaceItems(ctx, tx, userID, q, cursor, 51)
	if err != nil {
		return nil, err
	}
	if len(items) > 50 {
		items = items[:50]
		p.NextOffset = q.Offset + 50
		p.NextCursor = nextSpaceCursor(userID, q, revision, items[49])
	}
	p.Items = items
	if p.Usage, err = readSpaceUsageTx(ctx, tx, userID); err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT id::text,kind,name,COALESCE(folder_id::text,''),starred,trashed,version,created_at,updated_at,id::text,''::text,0::bigint,'ready'::text,''::text,0::bigint,lower(name) COLLATE "C",''::text FROM zeroagent_cloud_space_metadata WHERE user_id=$1 AND kind='folder' AND NOT trashed ORDER BY lower(name) COLLATE "C",id LIMIT $2`, userID, CloudSpaceMaxFolders)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		item, e := scanSpaceItem(rows)
		if e != nil {
			rows.Close()
			return nil, e
		}
		p.Folders = append(p.Folders, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if p.Pinned, err = querySpaceItems(ctx, tx, userID, CloudSpaceQuery{Category: "all", Scope: "starred", Sort: "updated"}, nil, 6); err != nil {
		return nil, err
	}
	return p, tx.Commit()
}
