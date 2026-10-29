package cloudbackup

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"strconv"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

func canonicalResource(r Resource) bool {
	if r.UserID <= 0 || r.Size < 0 || r.Size > 32<<20 || !digest.MatchString(r.SHA256) || r.MIME == "" {
		return false
	}
	id, err := uuid.Parse(r.ID)
	if err != nil || id.String() != r.ID {
		return false
	}
	ownerHash := sha256.Sum256([]byte(strconv.FormatInt(r.UserID, 10)))
	owner := hex.EncodeToString(ownerHash[:16])
	metadata := map[string]string{}
	key := "accounts/" + owner
	if r.Kind == "file" {
		key += "/files/" + r.ID + "/original"
		metadata = map[string]string{"file-id": r.ID, "owner-scope": owner}
	} else if r.Kind == "artifact" {
		family, err := uuid.Parse(r.FamilyID)
		if err != nil || family.String() != r.FamilyID {
			return false
		}
		key += "/artifacts/" + r.FamilyID + "/" + r.ID + "/content"
		metadata = map[string]string{"artifact-version": r.ID, "artifact-family": r.FamilyID, "owner-scope": "account-" + owner}
	} else {
		return false
	}
	return r.Key == key && string(mustJSON(r.Metadata)) == string(mustJSON(metadata)) && r.Archive == "objects/"+r.SHA256+".bin"
}
func mustJSON(value any) []byte { encoded, _ := json.Marshal(value); return encoded }
func (e *Engine) resources(ctx context.Context, tx *sql.Tx) ([]Resource, error) {
	schema := `"` + e.Config.Schema + `".`
	rows, err := tx.QueryContext(ctx, `SELECT 'file',id::text,''::text,user_id,object_key,size,sha256,mime FROM `+schema+`zeroagent_cloud_files WHERE uploaded_at IS NOT NULL AND deleted_at IS NULL AND state NOT IN ('uploading','deleting','deleted')
 UNION ALL SELECT 'artifact',id::text,family_id::text,user_id,object_key,size,sha256,mime FROM `+schema+`zeroagent_cloud_artifact_versions WHERE state='ready' AND deleted_at IS NULL ORDER BY 1,2`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Resource{}
	var total int64
	for rows.Next() {
		var r Resource
		if err = rows.Scan(&r.Kind, &r.ID, &r.FamilyID, &r.UserID, &r.Key, &r.Size, &r.SHA256, &r.MIME); err != nil {
			return nil, err
		}
		ownerHash := sha256.Sum256([]byte(strconv.FormatInt(r.UserID, 10)))
		owner := hex.EncodeToString(ownerHash[:16])
		if r.Kind == "file" {
			r.Metadata = map[string]string{"file-id": r.ID, "owner-scope": owner}
		} else {
			r.Metadata = map[string]string{"artifact-version": r.ID, "artifact-family": r.FamilyID, "owner-scope": "account-" + owner}
		}
		r.Archive = "objects/" + r.SHA256 + ".bin"
		total += r.Size
		if !canonicalResource(r) || len(result) >= e.Config.MaxObjects || total > e.Config.MaxTotalBytes {
			return nil, ErrInvalid
		}
		result = append(result, r)
	}
	return result, rows.Err()
}
func verifyObject(ctx context.Context, store objectstore.Store, r Resource, output io.Writer) error {
	object, err := store.Get(ctx, r.Key)
	if err != nil {
		return err
	}
	defer object.Body.Close()
	if object.Size != r.Size || object.SHA256 != r.SHA256 || object.ContentType != r.MIME {
		return ErrIntegrity
	}
	for key, value := range r.Metadata {
		if object.Metadata[key] != value {
			return ErrIntegrity
		}
	}
	hash := sha256.New()
	target := io.Writer(hash)
	if output != nil {
		target = io.MultiWriter(hash, output)
	}
	n, err := io.Copy(target, io.LimitReader(object.Body, r.Size+1))
	if err != nil {
		return err
	}
	if n != r.Size || hex.EncodeToString(hash.Sum(nil)) != r.SHA256 {
		return ErrIntegrity
	}
	return nil
}
func verifyArchived(ctx context.Context, root string, r Resource) error {
	if !canonicalResource(r) {
		return ErrInvalid
	}
	path, err := archivePath(root, r.Archive)
	if err != nil {
		return err
	}
	info, err := hashFileContext(ctx, path, r.Size)
	if err != nil {
		return err
	}
	if info.Bytes != r.Size || info.SHA256 != r.SHA256 {
		return ErrIntegrity
	}
	return nil
}
func restoreObject(ctx context.Context, store ConditionalObjects, root string, r Resource) error {
	path, err := archivePath(root, r.Archive)
	if err != nil {
		return err
	}
	input, err := os.Open(path)
	if err != nil {
		return err
	}
	defer input.Close()
	if err = store.PutIfAbsent(ctx, r.Key, input, r.Size, objectstore.PutOptions{ContentType: r.MIME, SHA256: r.SHA256, Metadata: r.Metadata}); err != nil {
		return err
	}
	return verifyObject(ctx, store, r, nil)
}
