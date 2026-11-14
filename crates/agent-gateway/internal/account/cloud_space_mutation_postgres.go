package account

import (
	"context"
	"database/sql"
	"unicode/utf8"
)

// Only the target and destination folder enter application memory. Folder count
// and membership are database predicates under the existing metadata lock.
func readSpaceMutationTx(ctx context.Context, tx *sql.Tx, userID int64, m CloudSpaceMetadata) (*CloudSpaceSnapshot, error) {
	if _, err := canonicalCloudFileID(m.ID); err != nil {
		return nil, err
	}
	if (m.Kind != "file" && m.Kind != "artifact" && m.Kind != "folder") || m.Version < 0 || !utf8.ValidString(m.Name) || (m.Name != "" && !validCloudFileName(m.Name)) {
		return nil, ErrCloudFileInvalid
	}
	rows, err := tx.QueryContext(ctx, spaceProjection+"SELECT "+spaceItemColumns+" FROM projected WHERE id::text=$2 OR (kind='folder' AND id::text=$3)", userID, m.ID, m.FolderID)
	if err != nil {
		return nil, err
	}
	snapshot := &CloudSpaceSnapshot{Items: []CloudSpaceItem{}}
	current := false
	for rows.Next() {
		item, e := scanSpaceItem(rows)
		if e != nil {
			_ = rows.Close()
			return nil, e
		}
		snapshot.Items = append(snapshot.Items, item)
		current = current || (item.ID == m.ID && item.Kind == m.Kind)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	if m.Kind == "folder" && !current {
		var count int
		if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM zeroagent_cloud_space_metadata WHERE user_id=$1 AND kind='folder'`, userID).Scan(&count); err != nil {
			return nil, err
		}
		if count >= CloudSpaceMaxFolders {
			return nil, ErrCloudSpaceConflict
		}
	}
	if m.Kind == "folder" && m.Trashed {
		var contains bool
		err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zeroagent_cloud_space_metadata m WHERE m.user_id=$1 AND m.folder_id::text=$2 AND
 ((m.kind='file' AND EXISTS(SELECT 1 FROM zeroagent_cloud_files f WHERE f.user_id=m.user_id AND f.id=m.id AND f.deleted_at IS NULL AND f.state<>'deleted')) OR
 (m.kind='artifact' AND EXISTS(SELECT 1 FROM zeroagent_cloud_artifact_versions a WHERE a.user_id=m.user_id AND a.family_id=m.id AND a.deleted_at IS NULL AND a.state<>'deleted'))))`, userID, m.ID).Scan(&contains)
		if err != nil {
			return nil, err
		}
		if contains {
			return nil, ErrCloudSpaceConflict
		}
	}
	return snapshot, nil
}
