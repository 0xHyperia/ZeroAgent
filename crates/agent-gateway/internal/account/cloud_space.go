package account

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

// Space metadata organizes canonical originals and artifact families. It never
// copies bytes, parsed content, credentials, or execution authority.
const CloudSpaceMaxFolders = 100
const CloudSpaceDefaultBytes = CloudFileMaxAccountBytes + CloudArtifactMaxAccountBytes

var ErrCloudSpaceConflict = errors.New("space metadata changed")

type CloudSpaceMetadata struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`
	Name      string    `json:"name"`
	FolderID  string    `json:"folder_id"`
	Starred   bool      `json:"starred"`
	Trashed   bool      `json:"trashed"`
	Version   int64     `json:"version"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}
type CloudSpaceItem struct {
	CloudSpaceMetadata
	TargetID       string `json:"target_id"`
	MIME           string `json:"mime"`
	Size           int64  `json:"size"`
	State          string `json:"state"`
	ConversationID string `json:"conversation_id"`
	Versions       int    `json:"versions"`
	SiteVersionID  string `json:"site_version_id,omitempty"`
	sortName       string
}
type CloudSpaceUsage struct {
	UsedBytes            int64 `json:"used_bytes"`
	LimitBytes           int64 `json:"limit_bytes"`
	FileBytes            int64 `json:"file_bytes"`
	ArtifactBytes        int64 `json:"artifact_bytes"`
	FileLimitBytes       int64 `json:"file_limit_bytes"`
	ArtifactLimitBytes   int64 `json:"artifact_limit_bytes"`
	FileCount            int   `json:"file_count"`
	ArtifactVersionCount int   `json:"artifact_version_count"`
	TrashBytes           int64 `json:"trash_bytes"`
	FileLimitCount       int   `json:"file_limit_count"`
	ArtifactLimitCount   int   `json:"artifact_limit_count"`
}
type CloudSpaceSnapshot struct {
	Items []CloudSpaceItem `json:"items"`
	Usage CloudSpaceUsage  `json:"usage"`
}
type CloudSpaceStore interface {
	ReadCloudSpace(context.Context, int64) (*CloudSpaceSnapshot, error)
	QueryCloudSpace(context.Context, int64, CloudSpaceQuery) (*CloudSpacePage, error)
	PutCloudSpaceMetadata(context.Context, int64, CloudSpaceMetadata) (*CloudSpaceMetadata, error)
}
type cloudSpaceRecords struct {
	files     []CloudFile
	artifacts []CloudArtifactVersion
	sites     map[string]CloudSiteRelease
	metadata  []CloudSpaceMetadata
	limits    CloudSpaceLimits
}

func (r cloudSpaceRecords) snapshot() *CloudSpaceSnapshot {
	limits := r.limits
	if limits.TotalBytes == 0 {
		limits = defaultSpaceLimits()
	}
	out := &CloudSpaceSnapshot{Items: []CloudSpaceItem{}, Usage: CloudSpaceUsage{LimitBytes: limits.TotalBytes, FileLimitBytes: limits.FileBytes, ArtifactLimitBytes: limits.ArtifactBytes, FileLimitCount: limits.MaxFiles, ArtifactLimitCount: limits.MaxArtifactVersions}}
	metadata := map[string]CloudSpaceMetadata{}
	for _, m := range r.metadata {
		metadata[m.Kind+":"+m.ID] = m
	}
	apply := func(item CloudSpaceItem) CloudSpaceItem {
		if m, ok := metadata[item.Kind+":"+item.ID]; ok {
			if m.Name != "" {
				item.Name = m.Name
			}
			item.FolderID, item.Starred, item.Trashed, item.Version = m.FolderID, m.Starred, m.Trashed, m.Version
			if m.UpdatedAt.After(item.UpdatedAt) {
				item.UpdatedAt = m.UpdatedAt
			}
		}
		return item
	}
	for _, f := range r.files {
		if f.State == CloudFileDeleted {
			continue
		}
		out.Usage.FileBytes += f.Size
		out.Usage.FileCount++
		if m := metadata["file:"+f.ID]; m.Trashed {
			out.Usage.TrashBytes += f.Size
		}
		if f.DeletedAt != nil {
			continue
		}
		out.Items = append(out.Items, apply(CloudSpaceItem{CloudSpaceMetadata: CloudSpaceMetadata{ID: f.ID, Kind: "file", Name: f.Name, CreatedAt: f.CreatedAt, UpdatedAt: f.UpdatedAt}, TargetID: f.ID, MIME: f.MIME, Size: f.Size, State: f.State, ConversationID: f.ConversationID}))
	}
	latest := map[string]CloudArtifactVersion{}
	latestSite := map[string]CloudArtifactVersion{}
	counts := map[string]int{}
	for _, a := range r.artifacts {
		if a.State == CloudArtifactDeleted {
			continue
		}
		out.Usage.ArtifactBytes += a.Size
		out.Usage.ArtifactVersionCount++
		if m := metadata["artifact:"+a.FamilyID]; m.Trashed {
			out.Usage.TrashBytes += a.Size
		}
		if a.DeletedAt != nil {
			continue
		}
		counts[a.FamilyID]++
		if site, ok := r.sites[a.ID]; ok && a.State == CloudArtifactReady && site.SiteID == a.FamilyID && site.SHA256 == a.SHA256 {
			if old, ok := latestSite[a.FamilyID]; !ok || a.Number > old.Number {
				latestSite[a.FamilyID] = a
			}
		}
		if old, ok := latest[a.FamilyID]; !ok || a.Number > old.Number {
			latest[a.FamilyID] = a
		}
	}
	for _, a := range latest {
		siteID := ""
		if site, ok := latestSite[a.FamilyID]; ok && (a.State != CloudArtifactReady || a.ID == site.ID) {
			siteID = site.ID
		}
		out.Items = append(out.Items, apply(CloudSpaceItem{CloudSpaceMetadata: CloudSpaceMetadata{ID: a.FamilyID, Kind: "artifact", Name: a.Name, CreatedAt: a.CreatedAt, UpdatedAt: a.UpdatedAt}, TargetID: a.ID, MIME: a.MIME, Size: a.Size, State: a.State, ConversationID: a.ConversationID, Versions: counts[a.FamilyID], SiteVersionID: siteID}))
	}
	for _, m := range r.metadata {
		if m.Kind == "folder" {
			out.Items = append(out.Items, CloudSpaceItem{CloudSpaceMetadata: m, TargetID: m.ID, State: "ready"})
		}
	}
	out.Usage.UsedBytes = out.Usage.FileBytes + out.Usage.ArtifactBytes
	return out
}

func validateSpaceMutation(snapshot *CloudSpaceSnapshot, m CloudSpaceMetadata) error {
	if _, err := uuid.Parse(m.ID); err != nil {
		return ErrCloudFileInvalid
	}
	if m.Kind != "file" && m.Kind != "artifact" && m.Kind != "folder" {
		return ErrCloudFileInvalid
	}
	if m.Version < 0 || (m.Name != "" && !validCloudFileName(m.Name)) || !utf8.ValidString(m.Name) {
		return ErrCloudFileInvalid
	}
	var current *CloudSpaceItem
	folders := 0
	for i := range snapshot.Items {
		item := &snapshot.Items[i]
		if item.ID == m.ID && item.Kind != m.Kind {
			return ErrCloudFileInvalid
		}
		if item.Kind == "folder" {
			folders++
		}
		if item.ID == m.ID && item.Kind == m.Kind {
			current = item
		}
	}
	if current == nil {
		if m.Kind != "folder" {
			return ErrNotFound
		}
		if m.Version != 0 || m.Name == "" || folders >= CloudSpaceMaxFolders {
			return ErrCloudSpaceConflict
		}
	} else if current.Version != m.Version {
		return ErrCloudSpaceConflict
	}
	if m.Kind == "folder" && (m.Name == "" || m.FolderID != "") {
		return ErrCloudFileInvalid
	}
	if m.FolderID != "" {
		found := false
		for _, item := range snapshot.Items {
			if item.Kind == "folder" && item.ID == m.FolderID && !item.Trashed {
				found = true
			}
		}
		if !found {
			return ErrNotFound
		}
	}
	if m.Kind == "folder" && m.Trashed {
		for _, item := range snapshot.Items {
			if item.FolderID == m.ID {
				return ErrCloudSpaceConflict
			}
		}
	}
	return nil
}

// In-memory contract/reference implementation. Production library requests use
// QueryCloudSpace's bounded database projection, never this whole snapshot.
func filterCloudSpace(snapshot *CloudSpaceSnapshot, query, category, scope, folder, order string, offset int) ([]CloudSpaceItem, int) {
	result := filterCloudSpaceItems(snapshot, query, category, scope, folder, order)
	total := len(result)
	if offset > total {
		offset = total
	}
	return result[offset:min(offset+50, total)], total
}

func filterCloudSpaceItems(snapshot *CloudSpaceSnapshot, query, category, scope, folder, order string) []CloudSpaceItem {
	result := []CloudSpaceItem{}
	for _, item := range snapshot.Items {
		if item.Trashed != (scope == "trash") {
			continue
		}
		if scope == "starred" && !item.Starred {
			continue
		}
		if folder != "" && item.FolderID != folder {
			continue
		}
		if folder == "" && query == "" && scope == "all" && category == "all" && item.FolderID != "" {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(item.Name), strings.ToLower(query)) {
			continue
		}
		if category == "uploads" && item.Kind != "file" || category == "outputs" && item.Kind != "artifact" {
			continue
		}
		if category == "images" && !strings.HasPrefix(item.MIME, "image/") {
			continue
		}
		if category == "sites" && item.SiteVersionID == "" {
			continue
		}
		if category == "documents" && (item.Kind == "folder" || strings.HasPrefix(item.MIME, "image/")) {
			continue
		}
		result = append(result, item)
	}
	sort.Slice(result, func(i, j int) bool {
		a, b := result[i], result[j]
		if a.Kind == "folder" && b.Kind != "folder" {
			return true
		}
		if b.Kind == "folder" && a.Kind != "folder" {
			return false
		}
		if order == "name" && !strings.EqualFold(a.Name, b.Name) {
			return strings.ToLower(a.Name) < strings.ToLower(b.Name)
		}
		if order == "size" && a.Size != b.Size {
			return a.Size > b.Size
		}
		if !a.UpdatedAt.Equal(b.UpdatedAt) {
			return a.UpdatedAt.After(b.UpdatedAt)
		}
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		return a.ID > b.ID
	})
	return result
}
