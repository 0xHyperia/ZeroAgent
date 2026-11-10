import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const { createGatewayGitClient } = loader.loadModule("src/lib/git/gatewayGitClient.ts");

test("gateway git client forwards worktree create and remove operations", async () => {
  const calls = [];
  const api = {
    async gitRequest(action, workdir, args) {
      calls.push({ action, workdir, args });
      if (action === "create_worktree") {
        return { ok: true, worktreePath: "/workspace/.worktrees/topic" };
      }
      return { ok: true, worktreeRemoved: true };
    },
  };
  const client = createGatewayGitClient(api);

  const created = await client.createWorktree("/workspace/project", {
    branch: "topic",
    directoryName: "topic-dir",
    parentDirectory: "/workspace/worktrees",
    startPoint: "main",
  });
  const removed = await client.removeWorktree("/workspace/project", "/workspace/.worktrees/topic", {
    force: true,
    deleteBranch: true,
  });

  assert.equal(created.worktreePath, "/workspace/.worktrees/topic");
  assert.equal(removed.worktreeRemoved, true);
  assert.deepEqual(calls, [
    {
      action: "create_worktree",
      workdir: "/workspace/project",
      args: {
        branch: "topic",
        directoryName: "topic-dir",
        parentDirectory: "/workspace/worktrees",
        startPoint: "main",
      },
    },
    {
      action: "remove_worktree",
      workdir: "/workspace/project",
      args: {
        worktreePath: "/workspace/.worktrees/topic",
        force: true,
        deleteBranch: true,
      },
    },
  ]);
});

test("gateway git review forwards options and preserves stats even when the patch is omitted", async () => {
  const calls = [];
  const client = createGatewayGitClient({
    async gitRequest(action, workdir, args) {
      calls.push({ action, workdir, args });
      return {
        totals: { additions: 310_000, deletions: 15_000 },
        changes: [
          { path: "renamed.txt", oldPath: "old.txt", additions: 42, deletions: 0 },
          { path: "binary.png", additions: null, deletions: null },
        ],
        patch: "",
        patchOmitted: true,
      };
    },
  });
  const mode = "branch:refs/remotes/origin/main";
  const diff = await client.diff("/workspace/project", mode, undefined, { paginateLarge: true });
  await client.commitDiff("/workspace/project", "ca3bcf2", "renamed.txt", {
    previousPath: "old.txt",
    hideWhitespace: true,
    fullContext: true,
  });
  assert.deepEqual(diff.totals, { additions: 310_000, deletions: 15_000 });
  assert.equal(diff.patchOmitted, true);
  assert.equal(diff.changes[0].additions, 42);
  assert.equal(diff.changes[0].deletions, 0);
  assert.equal(diff.changes[1].additions, undefined);
  assert.deepEqual(calls, [
    { action: "diff", workdir: "/workspace/project", args: { mode, path: undefined, paginateLarge: true } },
    { action: "commit_diff", workdir: "/workspace/project", args: {
      commit: "ca3bcf2", path: "renamed.txt", previousPath: "old.txt", hideWhitespace: true, fullContext: true,
    } },
  ]);
});
