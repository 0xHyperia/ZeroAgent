package account

import (
	"context"
	"testing"
	"time"
)

func TestUpdateAgentWorkspacesReplacesCompleteSnapshot(t *testing.T) {
	const agentID = "agent-123e4567-e89b-42d3-a456-426614174000"
	store := NewMemoryStore()
	service := NewService(store, nil, time.Hour, time.Hour)
	device := &Device{
		ID: agentID, AgentID: agentID, UserID: 1,
		Workspaces: []Workspace{
			{ID: "keep", Name: "Old", Path: "/old"},
			{ID: "remove", Name: "Remove", Path: "/remove"},
		},
	}
	if err := store.UpsertDevice(context.Background(), device); err != nil {
		t.Fatalf("seed device: %v", err)
	}
	if err := service.UpdateAgentWorkspaces(context.Background(), agentID, []Workspace{
		{ID: "keep", Name: "Renamed", Path: "/new"},
		{ID: "added", Name: "Added", Path: "/added"},
	}); err != nil {
		t.Fatalf("update snapshot: %v", err)
	}
	workspaces, err := service.AgentWorkspaces(context.Background(), agentID)
	if err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	if len(workspaces) != 2 {
		t.Fatalf("unexpected workspace count: %d", len(workspaces))
	}
	var kept *Workspace
	for index := range workspaces {
		if workspaces[index].ID == "remove" {
			t.Fatal("removed workspace survived replacement snapshot")
		}
		if workspaces[index].ID == "keep" {
			kept = &workspaces[index]
		}
	}
	if kept == nil || kept.Name != "Renamed" || kept.Path != "/new" {
		t.Fatalf("workspace fields were not replaced correctly: %#v", kept)
	}
}

func TestUpdateAgentWorkspacesEmptySnapshotClearsDirectory(t *testing.T) {
	const agentID = "agent-123e4567-e89b-42d3-a456-426614174000"
	store := NewMemoryStore()
	service := NewService(store, nil, time.Hour, time.Hour)
	device := &Device{ID: agentID, AgentID: agentID, UserID: 1, Workspaces: []Workspace{{ID: "keep", Name: "Keep", Path: "/keep"}}}
	if err := store.UpsertDevice(context.Background(), device); err != nil {
		t.Fatalf("seed device: %v", err)
	}
	if err := service.UpdateAgentWorkspaces(context.Background(), agentID, nil); err != nil {
		t.Fatalf("empty snapshot: %v", err)
	}
	workspaces, _ := service.AgentWorkspaces(context.Background(), agentID)
	if len(workspaces) != 0 {
		t.Fatalf("empty snapshot did not clear workspaces: %#v", workspaces)
	}
}
