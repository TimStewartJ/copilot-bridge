import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createTestApp } from "./helpers.js";

const readGitWorktreeStatusMock = vi.hoisted(() => vi.fn());

vi.mock("../git-worktree-status.js", () => ({
  readGitWorktreeStatus: readGitWorktreeStatusMock,
}));

let app: Express;
let taskStore: ReturnType<typeof createTestApp>["ctx"]["taskStore"];

beforeEach(() => {
  readGitWorktreeStatusMock.mockReset();
  const testApp = createTestApp();
  app = testApp.app;
  taskStore = testApp.ctx.taskStore;
});

describe("task git status route", () => {
  it("returns git worktree status for a task cwd", async () => {
    const task = taskStore.createTask("Track git status");
    taskStore.updateTask(task.id, { cwd: "/workspace/copilot-bridge" });
    readGitWorktreeStatusMock.mockResolvedValue({
      status: "ok",
      cwd: "/workspace/copilot-bridge",
      repoRoot: "/workspace/copilot-bridge",
      repoName: "copilot-bridge",
      worktreePath: "/workspace/copilot-bridge",
      workspaceKind: "main",
      head: { kind: "branch", name: "main" },
      dirty: {
        clean: false,
        staged: 1,
        modified: 2,
        untracked: 3,
        conflicts: 0,
      },
      siblingWorktrees: [],
      branch: "main",
      clean: false,
      staged: 1,
      modified: 2,
      untracked: 3,
      conflicts: 0,
    });

    const res = await request(app).get(`/api/tasks/${task.id}/git-status`);

    expect(res.status).toBe(200);
    expect(readGitWorktreeStatusMock).toHaveBeenCalledWith("/workspace/copilot-bridge");
    expect(res.body).toEqual({
      status: "ok",
      cwd: "/workspace/copilot-bridge",
      repoRoot: "/workspace/copilot-bridge",
      repoName: "copilot-bridge",
      worktreePath: "/workspace/copilot-bridge",
      workspaceKind: "main",
      head: { kind: "branch", name: "main" },
      dirty: {
        clean: false,
        staged: 1,
        modified: 2,
        untracked: 3,
        conflicts: 0,
      },
      siblingWorktrees: [],
      branch: "main",
      clean: false,
      staged: 1,
      modified: 2,
      untracked: 3,
      conflicts: 0,
    });
  });

  it("returns 404 when the task does not exist", async () => {
    const res = await request(app).get("/api/tasks/missing-task/git-status");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Task not found" });
    expect(readGitWorktreeStatusMock).not.toHaveBeenCalled();
  });

  it("returns a typed not_configured result when the task has no cwd", async () => {
    const task = taskStore.createTask("No cwd");

    const res = await request(app).get(`/api/tasks/${task.id}/git-status`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "not_configured",
      error: "Task working directory is not configured.",
    });
    expect(readGitWorktreeStatusMock).not.toHaveBeenCalled();
  });

  it("treats whitespace-only cwd values as not configured", async () => {
    const task = taskStore.createTask("Blank cwd");
    taskStore.updateTask(task.id, { cwd: "   " });

    const res = await request(app).get(`/api/tasks/${task.id}/git-status`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "not_configured",
      error: "Task working directory is not configured.",
    });
    expect(readGitWorktreeStatusMock).not.toHaveBeenCalled();
  });

  it("passes through typed non-repo responses", async () => {
    const task = taskStore.createTask("Outside repo");
    taskStore.updateTask(task.id, { cwd: "/workspace/not-a-repo" });
    readGitWorktreeStatusMock.mockResolvedValue({
      status: "not_repo",
      cwd: "/workspace/not-a-repo",
    });

    const res = await request(app).get(`/api/tasks/${task.id}/git-status`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "not_repo",
      cwd: "/workspace/not-a-repo",
    });
  });

  it("returns a typed unavailable result when reading git status throws", async () => {
    const task = taskStore.createTask("Git unavailable");
    taskStore.updateTask(task.id, { cwd: "/workspace/copilot-bridge" });
    readGitWorktreeStatusMock.mockRejectedValue(new Error("spawn git ENOENT"));

    const res = await request(app).get(`/api/tasks/${task.id}/git-status`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "unavailable",
      cwd: "/workspace/copilot-bridge",
      error: "spawn git ENOENT",
    });
  });
});
