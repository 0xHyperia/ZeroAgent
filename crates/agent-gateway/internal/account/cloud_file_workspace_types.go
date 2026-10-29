package account

type CloudFileWorkspaceLoad struct {
	ConversationID    string
	RunID             string
	ToolOperationID   string
	LeaseOwner        string
	ExecutionAttempt  int64
	FileID            string
	ArtifactVersionID string
	Path              string
}
type CloudWorkspaceLoadedFile struct {
	FileID            string `json:"file_id,omitempty"`
	ArtifactVersionID string `json:"artifact_version_id,omitempty"`
	FamilyID          string `json:"family_id,omitempty"`
	Version           int64  `json:"version,omitempty"`
	Path              string `json:"path"`
	Name              string `json:"name"`
	MIME              string `json:"mime"`
	Size              int64  `json:"size"`
	SHA256            string `json:"sha256"`
}
