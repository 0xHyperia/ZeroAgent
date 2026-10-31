package account

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/lib/pq"
)

const CloudProjectSchema = `
CREATE TABLE IF NOT EXISTS zeroagent_cloud_projects (
 id UUID PRIMARY KEY,user_id BIGINT NOT NULL CHECK(user_id>0),
 name TEXT NOT NULL CHECK(octet_length(name) BETWEEN 1 AND 200),
 description TEXT NOT NULL DEFAULT '' CHECK(octet_length(description)<=4096),
 instructions TEXT NOT NULL DEFAULT '' CHECK(octet_length(instructions)<=16384),
 version BIGINT NOT NULL DEFAULT 1 CHECK(version>0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(id,user_id)
);
ALTER TABLE zeroagent_cloud_projects ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT 'folder';
ALTER TABLE zeroagent_cloud_projects ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS zeroagent_cloud_projects_owner_idx ON zeroagent_cloud_projects(user_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS zeroagent_cloud_project_conversations (
 conversation_id UUID PRIMARY KEY REFERENCES zerobox_cloud_conversations(id) ON DELETE CASCADE,
 user_id BIGINT NOT NULL,project_id UUID NULL,version BIGINT NOT NULL CHECK(version>0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 FOREIGN KEY(project_id,user_id) REFERENCES zeroagent_cloud_projects(id,user_id) ON DELETE SET NULL (project_id)
);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_project_conversations_page_idx ON zeroagent_cloud_project_conversations(user_id,project_id,created_at DESC,conversation_id DESC);
CREATE TABLE IF NOT EXISTS zeroagent_cloud_project_files (
 project_id UUID NOT NULL,user_id BIGINT NOT NULL,file_id UUID NOT NULL REFERENCES zeroagent_cloud_files(id) ON DELETE CASCADE,
 PRIMARY KEY(project_id,file_id),FOREIGN KEY(project_id,user_id) REFERENCES zeroagent_cloud_projects(id,user_id) ON DELETE CASCADE
);`

const cloudProjectColumns = `p.id::text,p.user_id,p.name,p.description,p.instructions,p.version,p.created_at,p.updated_at,p.icon,p.color`
const cloudProjectConversationColumns = `c.id::text,COALESCE(b.project_id::text,''),COALESCE(b.version,0),COALESCE(b.created_at,c.created_at),c.user_id,c.title,c.model,c.created_at,c.updated_at,c.pinned,c.archived,c.management_version`

func scanCloudProject(row interface{ Scan(...any) error }) (*CloudProject, error) {
	var p CloudProject
	err := row.Scan(&p.ID, &p.UserID, &p.Name, &p.Description, &p.Instructions, &p.Version, &p.CreatedAt, &p.UpdatedAt, &p.Icon, &p.Color)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func cloudProjectSQLError(err error) error {
	var pg *pq.Error
	if errors.As(err, &pg) && pg.Code == "23505" {
		return ErrCloudProjectConflict
	}
	return err
}

func (s *PersistentStore) CreateCloudProject(ctx context.Context, input *CloudProject) (*CloudProject, error) {
	if input == nil || input.UserID <= 0 || !validCloudProject(CloudProjectUpdate{Name: input.Name, Description: input.Description, Instructions: input.Instructions}) {
		return nil, ErrCloudProjectInvalid
	}
	project := *input
	if !normalizeCloudProjectAppearance(&project) {
		return nil, ErrCloudProjectInvalid
	}
	var err error
	if project.ID == "" {
		project.ID = uuid.NewString()
	} else if project.ID, err = cloudProjectID(project.ID); err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('zeroagent_cloud_projects:'||$1::text,0))`, project.UserID); err != nil {
		return nil, err
	}
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM zeroagent_cloud_projects WHERE user_id=$1`, project.UserID).Scan(&count); err != nil {
		return nil, err
	}
	if count >= CloudProjectMaxAccountProjects {
		return nil, ErrCloudProjectQuota
	}
	result, err := scanCloudProject(tx.QueryRowContext(ctx, `INSERT INTO zeroagent_cloud_projects AS p(id,user_id,name,description,instructions,icon,color) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING `+cloudProjectColumns, project.ID, project.UserID, project.Name, project.Description, project.Instructions, project.Icon, project.Color))
	if err != nil {
		return nil, cloudProjectSQLError(err)
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *PersistentStore) GetCloudProject(ctx context.Context, userID int64, id string) (*CloudProject, error) {
	id, err := cloudProjectID(id)
	if err != nil {
		return nil, err
	}
	return scanCloudProject(s.db.QueryRowContext(ctx, `SELECT `+cloudProjectColumns+` FROM zeroagent_cloud_projects p WHERE p.id=$1 AND p.user_id=$2`, id, userID))
}

func (s *PersistentStore) ListCloudProjects(ctx context.Context, userID int64, before string, limit int) ([]CloudProject, error) {
	before, err := cloudProjectListInput(userID, before, limit)
	if err != nil {
		return nil, err
	}
	var at any
	id := uuid.Nil.String()
	if before != "" {
		p, err := s.GetCloudProject(ctx, userID, before)
		if err != nil {
			return nil, err
		}
		at, id = p.CreatedAt, p.ID
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+cloudProjectColumns+` FROM zeroagent_cloud_projects p WHERE p.user_id=$1 AND ($2::timestamptz IS NULL OR (p.created_at,p.id)<($2,$3::uuid)) ORDER BY p.created_at DESC,p.id DESC LIMIT $4`, userID, at, id, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []CloudProject{}
	for rows.Next() {
		p, err := scanCloudProject(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *p)
	}
	return items, rows.Err()
}

func lockCloudProject(ctx context.Context, tx *sql.Tx, userID int64, id string) (*CloudProject, error) {
	id, err := cloudProjectID(id)
	if err != nil {
		return nil, err
	}
	return scanCloudProject(tx.QueryRowContext(ctx, `SELECT `+cloudProjectColumns+` FROM zeroagent_cloud_projects p WHERE p.id=$1 AND p.user_id=$2 FOR UPDATE`, id, userID))
}

func (s *PersistentStore) UpdateCloudProject(ctx context.Context, userID int64, id string, version int64, update CloudProjectUpdate) (*CloudProject, error) {
	if !validCloudProject(update) {
		return nil, ErrCloudProjectInvalid
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	p, err := lockCloudProject(ctx, tx, userID, id)
	if err != nil {
		return nil, err
	}
	if version < 1 || p.Version != version {
		return nil, ErrCloudProjectConflict
	}
	p, err = scanCloudProject(tx.QueryRowContext(ctx, `UPDATE zeroagent_cloud_projects p SET name=$3,description=$4,instructions=$5,icon=COALESCE($6,icon),color=COALESCE($7,color),version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 RETURNING `+cloudProjectColumns, p.ID, userID, update.Name, update.Description, update.Instructions, update.Icon, update.Color))
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return p, nil
}

func (s *PersistentStore) DeleteCloudProject(ctx context.Context, userID int64, id string, version int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	p, err := lockCloudProject(ctx, tx, userID, id)
	if err != nil {
		return err
	}
	if version < 1 || p.Version != version {
		return ErrCloudProjectConflict
	}
	if _, err = tx.ExecContext(ctx, `UPDATE zeroagent_cloud_project_conversations SET project_id=NULL,version=version+1 WHERE project_id=$1 AND user_id=$2`, p.ID, userID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM zeroagent_cloud_projects WHERE id=$1 AND user_id=$2`, p.ID, userID); err != nil {
		return err
	}
	return tx.Commit()
}

func scanCloudProjectConversation(row interface{ Scan(...any) error }) (*CloudProjectConversation, error) {
	var binding CloudProjectConversation
	var c CloudConversation
	err := row.Scan(&binding.ConversationID, &binding.ProjectID, &binding.Version, &binding.CreatedAt, &c.UserID, &c.Title, &c.Model, &c.CreatedAt, &c.UpdatedAt, &c.Pinned, &c.Archived, &c.ManagementVersion)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	c.ID = binding.ConversationID
	binding.Conversation = &c
	return &binding, nil
}

func (s *PersistentStore) GetCloudConversationProject(ctx context.Context, userID int64, id string) (*CloudProjectConversation, error) {
	id, err := cloudProjectID(id)
	if err != nil {
		return nil, err
	}
	return scanCloudProjectConversation(s.db.QueryRowContext(ctx, `SELECT `+cloudProjectConversationColumns+` FROM zerobox_cloud_conversations c LEFT JOIN zeroagent_cloud_project_conversations b ON b.conversation_id=c.id AND b.user_id=c.user_id WHERE c.id=$1 AND c.user_id=$2`, id, userID))
}

func (s *PersistentStore) SetCloudConversationProject(ctx context.Context, userID int64, conversationID, projectID string, version int64) (*CloudProjectConversation, error) {
	conversationID, err := cloudProjectID(conversationID)
	if err != nil {
		return nil, err
	}
	if projectID != "" {
		projectID, err = cloudProjectID(projectID)
		if err != nil {
			return nil, err
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var current string
	if err = tx.QueryRowContext(ctx, `SELECT id::text FROM zerobox_cloud_conversations WHERE id=$1 AND user_id=$2 FOR UPDATE`, conversationID, userID).Scan(&current); errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	if projectID != "" {
		if err = tx.QueryRowContext(ctx, `SELECT id::text FROM zeroagent_cloud_projects WHERE id=$1 AND user_id=$2 FOR KEY SHARE`, projectID, userID).Scan(&current); errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		} else if err != nil {
			return nil, err
		}
	}
	var foundVersion int64
	err = tx.QueryRowContext(ctx, `SELECT version FROM zeroagent_cloud_project_conversations WHERE conversation_id=$1 AND user_id=$2 FOR UPDATE`, conversationID, userID).Scan(&foundVersion)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if version < 0 || foundVersion != version {
		return nil, ErrCloudProjectConflict
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_project_conversations(conversation_id,user_id,project_id,version) VALUES($1,$2,NULLIF($3,'')::uuid,1) ON CONFLICT(conversation_id) DO UPDATE SET project_id=EXCLUDED.project_id,version=zeroagent_cloud_project_conversations.version+1 WHERE zeroagent_cloud_project_conversations.user_id=EXCLUDED.user_id`, conversationID, userID, projectID); err != nil {
		return nil, err
	}
	binding, err := scanCloudProjectConversation(tx.QueryRowContext(ctx, `SELECT `+cloudProjectConversationColumns+` FROM zerobox_cloud_conversations c JOIN zeroagent_cloud_project_conversations b ON b.conversation_id=c.id AND b.user_id=c.user_id WHERE c.id=$1 AND c.user_id=$2`, conversationID, userID))
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return binding, nil
}

func (s *PersistentStore) ListCloudProjectConversations(ctx context.Context, userID int64, projectID, before string, limit int) ([]CloudProjectConversation, error) {
	before, err := cloudProjectListInput(userID, before, limit)
	if err != nil {
		return nil, err
	}
	project, err := s.GetCloudProject(ctx, userID, projectID)
	if err != nil {
		return nil, err
	}
	var at any
	id := uuid.Nil.String()
	if before != "" {
		binding, err := s.GetCloudConversationProject(ctx, userID, before)
		if err != nil {
			return nil, err
		}
		if binding.ProjectID != project.ID {
			return nil, ErrNotFound
		}
		at, id = binding.CreatedAt, binding.ConversationID
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+cloudProjectConversationColumns+` FROM zeroagent_cloud_project_conversations b JOIN zerobox_cloud_conversations c ON c.id=b.conversation_id AND c.user_id=b.user_id WHERE b.user_id=$1 AND b.project_id=$2 AND ($3::timestamptz IS NULL OR (b.created_at,b.conversation_id)<($3,$4::uuid)) ORDER BY b.created_at DESC,b.conversation_id DESC LIMIT $5`, userID, project.ID, at, id, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []CloudProjectConversation{}
	for rows.Next() {
		binding, err := scanCloudProjectConversation(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *binding)
	}
	return items, rows.Err()
}

func (s *PersistentStore) SetCloudProjectFile(ctx context.Context, userID int64, projectID, fileID string, version int64, attached bool) (*CloudProject, error) {
	fileID, err := cloudProjectID(fileID)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	project, err := lockCloudProject(ctx, tx, userID, projectID)
	if err != nil {
		return nil, err
	}
	if version < 1 || project.Version != version {
		return nil, ErrCloudProjectConflict
	}
	var state string
	var deleted sql.NullTime
	if err = tx.QueryRowContext(ctx, `SELECT state,deleted_at FROM zeroagent_cloud_files WHERE id=$1 AND user_id=$2 FOR KEY SHARE`, fileID, userID).Scan(&state, &deleted); errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	if attached && (state != CloudFileReady || deleted.Valid) {
		return nil, ErrCloudProjectInvalid
	}
	if attached {
		var count int
		var exists bool
		if err = tx.QueryRowContext(ctx, `SELECT COUNT(*),COALESCE(bool_or(file_id=$2),false) FROM zeroagent_cloud_project_files r JOIN zeroagent_cloud_files f ON f.id=r.file_id AND f.user_id=r.user_id WHERE r.project_id=$1 AND f.deleted_at IS NULL AND f.state<>'deleted'`, project.ID, fileID).Scan(&count, &exists); err != nil {
			return nil, err
		}
		if !exists && count >= CloudProjectMaxFiles {
			return nil, ErrCloudProjectQuota
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_project_files(project_id,user_id,file_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, project.ID, userID, fileID)
	} else {
		_, err = tx.ExecContext(ctx, `DELETE FROM zeroagent_cloud_project_files WHERE project_id=$1 AND user_id=$2 AND file_id=$3`, project.ID, userID, fileID)
	}
	if err != nil {
		return nil, err
	}
	project, err = scanCloudProject(tx.QueryRowContext(ctx, `UPDATE zeroagent_cloud_projects p SET version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 RETURNING `+cloudProjectColumns, project.ID, userID))
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return project, nil
}

func (s *PersistentStore) ListCloudProjectFiles(ctx context.Context, userID int64, projectID, before string, limit int) ([]CloudFile, error) {
	before, err := cloudProjectListInput(userID, before, limit)
	if err != nil {
		return nil, err
	}
	project, err := s.GetCloudProject(ctx, userID, projectID)
	if err != nil {
		return nil, err
	}
	var at any
	id := uuid.Nil.String()
	if before != "" {
		var created time.Time
		err = s.db.QueryRowContext(ctx, `SELECT f.created_at FROM zeroagent_cloud_project_files r JOIN zeroagent_cloud_files f ON f.id=r.file_id AND f.user_id=r.user_id WHERE r.project_id=$1 AND r.user_id=$2 AND r.file_id=$3`, project.ID, userID, before).Scan(&created)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		} else if err != nil {
			return nil, err
		}
		at, id = created, before
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+cloudFileMetadataColumns+` FROM zeroagent_cloud_project_files r JOIN zeroagent_cloud_files f ON f.id=r.file_id AND f.user_id=r.user_id WHERE r.project_id=$1 AND r.user_id=$2 AND f.deleted_at IS NULL AND f.state<>'deleted' AND ($3::timestamptz IS NULL OR (f.created_at,f.id)<($3,$4::uuid)) ORDER BY f.created_at DESC,f.id DESC LIMIT $5`, project.ID, userID, at, id, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []CloudFile{}
	for rows.Next() {
		file, err := scanCloudFile(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *file)
	}
	return items, rows.Err()
}
