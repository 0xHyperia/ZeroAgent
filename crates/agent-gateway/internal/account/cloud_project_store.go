package account

import (
	"context"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
)

type CloudProjectStore interface {
	CreateCloudProject(context.Context, *CloudProject) (*CloudProject, error)
	GetCloudProject(context.Context, int64, string) (*CloudProject, error)
	ListCloudProjects(context.Context, int64, string, int) ([]CloudProject, error)
	UpdateCloudProject(context.Context, int64, string, int64, CloudProjectUpdate) (*CloudProject, error)
	DeleteCloudProject(context.Context, int64, string, int64) error
	GetCloudConversationProject(context.Context, int64, string) (*CloudProjectConversation, error)
	SetCloudConversationProject(context.Context, int64, string, string, int64) (*CloudProjectConversation, error)
	ListCloudProjectConversations(context.Context, int64, string, string, int) ([]CloudProjectConversation, error)
	SetCloudProjectFile(context.Context, int64, string, string, int64, bool) (*CloudProject, error)
	ListCloudProjectFiles(context.Context, int64, string, string, int) ([]CloudFile, error)
}

type CloudMemoryStore interface {
	CreateCloudMemory(context.Context, *CloudMemory) (*CloudMemory, error)
	GetCloudMemory(context.Context, int64, string) (*CloudMemory, error)
	ListCloudMemories(context.Context, int64, string, int) ([]CloudMemory, error)
	UpdateCloudMemory(context.Context, int64, string, int64, string, bool) (*CloudMemory, error)
	DeleteCloudMemory(context.Context, int64, string, int64) error
	GetCloudMemorySettings(context.Context, int64) (*CloudMemorySettings, error)
	SetCloudMemorySettings(context.Context, int64, int64, bool) (*CloudMemorySettings, error)
	// Reads a fresh, bounded snapshot of enabled entries only when the account
	// master switch is on. Missing settings mean disabled. No result is cached.
	GetCloudMemoryContext(context.Context, int64, int) (*CloudMemoryContext, error)
}

func cloudProjectID(id string) (string, error) {
	parsed, err := uuid.Parse(id)
	if err != nil {
		return "", ErrCloudProjectInvalid
	}
	return parsed.String(), nil
}

func cloudProjectText(value string, max int, required bool) bool {
	return len(value) <= max && utf8.ValidString(value) && !strings.ContainsRune(value, 0) && (!required || strings.TrimSpace(value) != "")
}

func validCloudProject(update CloudProjectUpdate) bool {
	return cloudProjectText(update.Name, 200, true) && strings.TrimSpace(update.Name) == update.Name && cloudProjectText(update.Description, 4096, false) && cloudProjectText(update.Instructions, CloudProjectMaxInstructions, false) &&
		(update.Icon == nil || validCloudProjectIcon(*update.Icon)) && (update.Color == nil || validCloudProjectColor(*update.Color))
}

func validCloudProjectIcon(icon string) bool {
	return slices.Contains(strings.Fields("folder book code terminal chart palette globe brain lightbulb pen star calendar target wrench image"), icon)
}
func validCloudProjectColor(color string) bool {
	return slices.Contains(strings.Fields("default red orange amber green blue violet pink"), color)
}
func normalizeCloudProjectAppearance(project *CloudProject) bool {
	if project.Icon == "" {
		project.Icon = "folder"
	}
	if project.Color == "" {
		project.Color = "default"
	}
	return validCloudProjectIcon(project.Icon) && validCloudProjectColor(project.Color)
}

func cloudProjectListInput(userID int64, before string, limit int) (string, error) {
	if userID <= 0 || limit < 1 || limit > 101 {
		return "", ErrCloudProjectInvalid
	}
	if before != "" {
		return cloudProjectID(before)
	}
	return "", nil
}
