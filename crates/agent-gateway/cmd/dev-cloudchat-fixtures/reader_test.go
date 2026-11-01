package main

import "testing"

func TestReaderProjectHasIsolatedStableConversationsAndNoRunnableWork(t *testing.T) {
	samples, refs := completeTestSamples(t)
	first, used, err := buildReaderFixtures(1, refs, samples)
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := buildReaderFixtures(1, refs, samples)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 6 || len(used) != 2 || digest(encoded(first)) != digest(encoded(second)) {
		t.Fatal("reader plan must be deterministic and contain guide, file demos, deliverables, queue and draft")
	}
	seen := map[string]bool{}
	for _, plan := range first {
		if plan.ProjectID != stableID(1, readerProjectKey) || seen[plan.Conversation.ID] {
			t.Fatal("project scope or stable IDs invalid")
		}
		seen[plan.Conversation.ID] = true
		if plan.Extras != nil && plan.Extras.Run != nil && !terminal(plan.Extras.Run.State) {
			t.Fatal("reader fixtures cannot execute")
		}
	}
	original, err := buildCompleteFixtures(1, refs, samples)
	if err != nil {
		t.Fatal(err)
	}
	for _, plan := range original {
		if seen[plan.Conversation.ID] {
			t.Fatal("reader profile must not reuse or move existing demos")
		}
	}
	if first[0].ProjectID == stableID(2, readerProjectKey) {
		t.Fatal("project IDs must be account scoped")
	}
}

func TestReaderProfileRequiresAccountOriginals(t *testing.T) {
	if _, _, err := buildReaderFixtures(1, nil, t.TempDir()); err == nil {
		t.Fatal("no files must be rejected")
	}
}
