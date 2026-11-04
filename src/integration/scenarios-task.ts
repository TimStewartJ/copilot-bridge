import { expect, vi } from "vitest";
import { request } from "../test-support/api-routes.js";
import type { IntegrationScenario } from "./scenario-types.js";

export const taskScenarios: IntegrationScenario[] = [
  {
    id: "TASK-01", title: "organizes a new task into a tagged group",
    async run(world) {
      const group = await world.createGroup("Delivery", { color: "purple" });
      const groupTag = await world.createTag("portfolio", { color: "blue" });
      await world.assignGroupTags(group.id, [groupTag.id]);
      const task = await world.createTask("Ship release", { groupId: group.id });
      const taskTag = await world.createTag("urgent", { color: "rose" });
      expect(taskTag).toMatchObject({ name: "urgent", color: "rose" });
      await world.assignTaskTags(task.id, [taskTag.id]);
      const detail = await world.getTask(task.id);
      expect(detail.groupId).toBe(group.id);
      expect(detail.tags).toMatchObject([{ id: taskTag.id, name: "urgent" }]);
      const groups = await request(world.app).get("/api/task-groups").expect(200);
      const organized = groups.body.groups.find((item: any) => item.id === group.id);
      expect(organized.tags).toMatchObject([{ id: groupTag.id, name: "portfolio" }]);
    },
  },
  {
    id: "TASK-02", title: "tracks task momentum through completion and archival",
    async run(world) {
      const task = await world.createTask("Production rollout");
      const changes = {
        title: "Shipping rollout", muted: true, notes: "Production notes",
        doneWhen: "All regions healthy",
        nextAction: "Deploy canary",
        waitingOn: "Change approval",
        nextTouchAt: "2030-01-02T12:00:00.000Z",
      };
      expect(await world.updateTask(task.id, changes)).toMatchObject(changes);
      expect(await world.getTask(task.id)).toMatchObject(changes);
      const archived = await world.updateTask(task.id, { completionAction: "complete-and-archive" });
      expect(archived).toMatchObject({ status: "archived", doneWhen: "All regions healthy", completedAt: expect.any(String) });
      expect(archived.nextAction).toBeUndefined();
      expect((await world.getTask(task.id)).status).toBe("archived");
    },
  },
  {
    id: "TASK-03", title: "renames a tag and reflects it on an already tagged task",
    async run(world) {
      const task = await world.createTask("Triage incident");
      const tag = await world.createTag("sev2");
      await world.assignTaskTags(task.id, [tag.id]);
      const update = await request(world.app).patch(`/api/tags/${tag.id}`).send({ name: "sev1", color: "rose" });
      expect(update.status).toBe(200);
      expect(update.body.tag).toMatchObject({ id: tag.id, name: "sev1", color: "rose" });
      expect((await world.getTask(task.id)).tags).toEqual([expect.objectContaining({ id: tag.id, name: "sev1" })]);
    },
  },
  {
    id: "TASK-04", title: "removes a deleted tag from every linked task",
    async run(world) {
      const first = await world.createTask("First tagged task");
      const second = await world.createTask("Second tagged task");
      const tag = await world.createTag("temporary");
      await world.assignTaskTags(first.id, [tag.id]);
      await world.assignTaskTags(second.id, [tag.id]);
      const evict = vi.spyOn(world.ctx.sessionManager, "evictAllCachedSessions");
      const removed = await request(world.app).delete(`/api/tags/${tag.id}`);
      expect(removed.status).toBe(200);
      expect(removed.body.success).toBe(true);
      expect(evict).toHaveBeenCalledOnce();
      expect(world.ctx.tagStore!.getTag(tag.id)).toBeUndefined();
      expect((await world.getTask(first.id)).tags).toEqual([]);
      expect((await world.getTask(second.id)).tags).toEqual([]);
    },
  },
  {
    id: "TASK-05", title: "ungroups tasks while deleting their former group",
    async run(world) {
      const group = await world.createGroup("Temporary program");
      const first = await world.createTask("First workstream", { groupId: group.id });
      const second = await world.createTask("Second workstream", { groupId: group.id });
      const groups = world.ctx.taskGroupStore!;
      const other = groups.createGroup("Other program");
      const untouched = world.ctx.taskStore.createTask("Other work", other.id);
      const tag = world.ctx.tagStore!.createTag("group-tag");
      world.ctx.tagStore!.setEntityTags("task_group", group.id, [tag.id]);
      const old = "2020-01-01T00:00:00.000Z";
      world.db.prepare("UPDATE tasks SET updatedAt = ? WHERE groupId = ?").run(old, group.id);
      const observed: Array<{ id: string; committed: boolean }> = [];
      const unsubscribe = world.ctx.globalBus.subscribe((event) => {
        if (event.type !== "task:changed" || !event.taskId) return;
        const task = world.ctx.taskStore.getTask(event.taskId);
        observed.push({ id: event.taskId, committed: !world.db.isTransaction && !groups.getGroup(group.id)
          && !!task && task.groupId === undefined && task.updatedAt !== old });
      });
      let removed;
      try {
        removed = await request(world.app).delete(`/api/task-groups/${group.id}`);
      } finally {
        unsubscribe();
      }
      expect(observed).toHaveLength(2);
      expect(observed).toEqual(expect.arrayContaining([{ id: first.id, committed: true }, { id: second.id, committed: true }]));
      expect(world.ctx.tagStore!.getEntityTags("task_group", group.id)).toEqual([]);
      expect(groups.listGroups()).toMatchObject([{ id: other.id, order: 0 }]);
      expect(world.ctx.taskStore.getTask(untouched.id)?.groupId).toBe(other.id);
      expect(removed.status).toBe(200);
      expect(removed.body).toMatchObject({ success: true, deleted: true, ungroupedTaskCount: 2 });
      expect(groups.getGroup(group.id)).toBeUndefined();
      expect((await world.getTask(first.id)).groupId).toBeUndefined();
      expect((await world.getTask(second.id)).groupId).toBeUndefined();
      const again = await request(world.app).delete(`/api/task-groups/${group.id}`).expect(200);
      expect(again.body).toEqual({ success: true, deleted: false, ungroupedTaskCount: 0 });
    },
  },
  {
    id: "TASK-06", title: "moves a task between groups and then returns it to the ungrouped queue",
    async run(world) {
      const backlog = await world.createGroup("Backlog");
      const active = await world.createGroup("Active");
      const task = await world.createTask("Move through workflow", { groupId: backlog.id });
      expect((await world.updateTask(task.id, { groupId: active.id })).groupId).toBe(active.id);
      expect((await world.updateTask(task.id, { groupId: null })).groupId).toBeUndefined();
      expect((await world.getTask(task.id)).groupId).toBeUndefined();
    },
  },
  {
    id: "TASK-08", title: "reorders tasks without losing group and tag relationships",
    async run(world) {
      const group = await world.createGroup("Ordered");
      const tag = await world.createTag("stable");
      const first = await world.createTask("First", { groupId: group.id });
      const second = await world.createTask("Second", { groupId: group.id });
      await world.assignTaskTags(first.id, [tag.id]);
      const reordered = await request(world.app).put("/api/tasks/reorder").send({ taskIds: [second.id, first.id] });
      expect(reordered.status).toBe(200);
      const listed = await request(world.app).get("/api/tasks");
      expect(listed.body.tasks.map((item: any) => item.id)).toEqual([second.id, first.id]);
      expect((await world.getTask(first.id)).tags[0].id).toBe(tag.id);
    },
  },
  {
    id: "TASK-09", title: "reorders groups while retaining their tasks",
    async run(world) {
      const first = await world.createGroup("First group");
      const second = await world.createGroup("Second group");
      const task = await world.createTask("Grouped work", { groupId: first.id });
      const reordered = await request(world.app).put("/api/task-groups/reorder").send({ groupIds: [second.id, first.id] });
      expect(reordered.status).toBe(200);
      const listed = await request(world.app).get("/api/task-groups").expect(200);
      expect(listed.body.groups.map((item: any) => item.id)).toEqual([second.id, first.id]);
      expect((await world.getTask(task.id)).groupId).toBe(first.id);
    },
  },
  {
    id: "TASK-10", title: "links and unlinks a work item without disturbing task momentum",
    async run(world) {
      const task = await world.createTask("Track issue");
      await world.updateTask(task.id, { nextAction: "Read issue" });
      const linked = await request(world.app).post(`/api/tasks/${task.id}/link`).send({ type: "workItem", workItemId: "octo/repo#42", provider: "github" });
      expect(linked.status).toBe(200);
      expect(linked.body.task.workItems).toEqual([expect.objectContaining({ id: "octo/repo#42", provider: "github" })]);
      const unlinked = await request(world.app).delete(`/api/tasks/${task.id}/link`).send({ type: "workItem", workItemId: "octo/repo#42", provider: "github" });
      expect(unlinked.status).toBe(200);
      expect(unlinked.body.task.workItems).toEqual([]);
      expect((await world.getTask(task.id))).toMatchObject({ workItems: [], nextAction: "Read issue" });
    },
  },
  {
    id: "TASK-11", title: "links multiple pull requests and removes one provider-specific reference",
    async run(world) {
      const task = await world.createTask("Coordinate PRs");
      const githubLink = await request(world.app).post(`/api/tasks/${task.id}/link`).send({ type: "pr", repoName: "octo/app", prId: 11, provider: "github" });
      const adoLink = await request(world.app).post(`/api/tasks/${task.id}/link`).send({ type: "pr", repoId: "5c0d7f3e-2a9b-4e61-8f3d-9b1a2c4e6d70", repoName: "API", prId: 12, provider: "ado" });
      expect(githubLink.status).toBe(200);
      expect(adoLink.status).toBe(200);
      expect((await world.getTask(task.id)).pullRequests).toHaveLength(2);
      const removed = await request(world.app).delete(`/api/tasks/${task.id}/link`).send({ type: "pr", repoName: "octo/app", prId: 11, provider: "github" });
      expect(removed.status).toBe(200);
      const detail = await world.getTask(task.id);
      expect(detail.pullRequests).toHaveLength(1);
      expect(detail.pullRequests[0]).toMatchObject({ provider: "ado", repoId: "5c0d7f3e-2a9b-4e61-8f3d-9b1a2c4e6d70", prId: 12 });
    },
  },
  {
    id: "TASK-12", title: "completes a checklist and exposes it through the dashboard",
    async run(world) {
      const task = await world.createTask("Launch checklist");
      const first = await world.createChecklistItem(task.id, "Draft", "2026-10-01");
      expect(first.deadline).toBe("2026-10-01");
      const second = await world.createChecklistItem(task.id, "Verify");
      await request(world.app).patch(`/api/checklist-items/${first.id}`).send({ text: "Publish", deadline: "2026-10-05" }).expect(200);
      const complete = await request(world.app).patch(`/api/checklist-items/${first.id}`).send({ done: true });
      expect(complete.status).toBe(200);
      const list = await request(world.app).get(`/api/tasks/${task.id}/checklist-items`).expect(200);
      expect(list.body.checklistItems).toContainEqual(expect.objectContaining({ id: first.id, text: "Publish", deadline: "2026-10-05", done: true }));
      const dashboard = await request(world.app).get("/api/dashboard/focus");
      expect(dashboard.body.completedChecklistItems).toContainEqual(expect.objectContaining({ id: first.id, taskId: task.id, taskTitle: "Launch checklist" }));
      expect(dashboard.body.openChecklistItems.map((item: any) => item.id)).toContain(second.id);
    },
  },
  {
    id: "TASK-14", title: "reorders a task checklist and preserves completion state",
    async run(world) {
      const task = await world.createTask("Ordered checklist");
      const first = await world.createChecklistItem(task.id, "First");
      const second = await world.createChecklistItem(task.id, "Second");
      const third = await world.createChecklistItem(task.id, "Third");
      await request(world.app).patch(`/api/checklist-items/${second.id}`).send({ done: true });
      const reordered = await request(world.app).put(`/api/tasks/${task.id}/checklist-items/reorder`).send({ checklistItemIds: [third.id, second.id, first.id] });
      expect(reordered.status).toBe(200);
      const list = await request(world.app).get(`/api/tasks/${task.id}/checklist-items`).expect(200);
      expect(list.body.checklistItems.map((item: any) => item.id)).toEqual([third.id, second.id, first.id]);
      expect(list.body.checklistItems[1].done).toBe(true);
    },
  },
  {
    id: "TASK-15", title: "deletes one checklist item while preserving its siblings",
    async run(world) {
      const task = await world.createTask("Trim checklist");
      const keep = await world.createChecklistItem(task.id, "Keep");
      const remove = await world.createChecklistItem(task.id, "Remove");
      const deleted = await request(world.app).delete(`/api/checklist-items/${remove.id}`);
      expect(deleted.status).toBe(200);
      const list = await request(world.app).get(`/api/tasks/${task.id}/checklist-items`);
      expect(list.body.checklistItems.map((item: any) => item.id)).toEqual([keep.id]);
      expect((await world.getTask(task.id)).title).toBe("Trim checklist");
    },
  },
  {
    id: "TASK-16", title: "combines global and task checklist queues without losing ownership",
    async run(world) {
      const task = await world.createTask("Owned item");
      const owned = await world.createChecklistItem(task.id, "Task item");
      const global = await request(world.app).post("/api/checklist-items").send({ text: "Global item" });
      expect(global.status).toBe(200);
      expect(global.body.checklistItem).toMatchObject({ text: "Global item", taskId: null });
      const open = await request(world.app).get("/api/checklist-items/open");
      expect(open.body.checklistItems).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: owned.id, taskId: task.id }),
        expect.objectContaining({ id: global.body.checklistItem.id, taskId: null }),
      ]));
    },
  },
  {
    id: "TASK-18", title: "keeps task state unchanged after an invalid group move",
    async run(world) {
      const group = await world.createGroup("Valid home");
      const task = await world.createTask("Stay put", { groupId: group.id });
      const before = world.ctx.taskStore.getTask(task.id);
      const rejected = await request(world.app).patch(`/api/tasks/${task.id}`).send({ groupId: "missing-group" }).expect(400);
      expect(rejected.body.error).toContain("Task group missing-group not found");
      expect(world.ctx.taskStore.getTask(task.id)).toEqual(before);
      expect((await world.getTask(task.id)).groupId).toBe(group.id);
      const listed = await request(world.app).get("/api/tasks").expect(200);
      expect(listed.body.tasks).toMatchObject([{ id: task.id, title: "Stay put" }]);
    },
  },
  {
    id: "TASK-19", title: "keeps earlier task edits after a later invalid mutation is rejected",
    async run(world) {
      const task = await world.createTask("Validated task");
      const item = await world.createChecklistItem(task.id, "Visible item");
      await world.updateTask(task.id, { title: "Accepted title", notes: "Accepted notes" });
      const dashboard = await request(world.app).get("/api/dashboard/focus").expect(200);
      expect(dashboard.body.openChecklistItems.find((entry: { id: string }) => entry.id === item.id)?.taskTitle).toBe("Accepted title");
      const rejected = await request(world.app).patch(`/api/tasks/${task.id}`).send({ priority: 1.5 });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toContain("priority must be a finite integer");
      expect(await world.getTask(task.id)).toMatchObject({ title: "Accepted title", notes: "Accepted notes", priority: 0 });
    },
  },
  {
    id: "TASK-21", title: "archives and restores a task while preserving relationships",
    async run(world) {
      const group = await world.createGroup("Persistent group");
      const tag = await world.createTag("persistent-tag");
      const task = await world.createTask("Archive cycle", { groupId: group.id });
      await world.assignTaskTags(task.id, [tag.id]);
      await world.updateTask(task.id, { status: "archived" });
      const restored = await world.updateTask(task.id, { status: "active" });
      expect(restored.groupId).toBe(group.id);
      expect((await world.getTask(task.id)).tags[0].id).toBe(tag.id);
    },
  },
  {
    id: "TASK-22", title: "changes task priority and mute state without changing order",
    async run(world) {
      const first = await world.createTask("First ordered task");
      const second = await world.createTask("Second ordered task");
      const before = (await request(world.app).get("/api/tasks")).body.tasks.map((item: any) => item.id);
      await world.updateTask(first.id, { priority: 9, muted: true });
      const listed = await request(world.app).get("/api/tasks");
      expect(listed.body.tasks.map((item: any) => item.id)).toEqual(before);
      expect(listed.body.tasks.find((item: any) => item.id === first.id)).toMatchObject({ priority: 9, muted: true });
      expect(listed.body.tasks.some((item: any) => item.id === second.id)).toBe(true);
    },
  },
  {
    id: "TASK-23", title: "updates group presentation without disrupting member tasks",
    async run(world) {
      const group = await world.createGroup("Program");
      const task = await world.createTask("Member", { groupId: group.id });
      const changes = { name: "Renamed program", color: "cyan", collapsed: true, notes: "Program notes" };
      const updated = await request(world.app).patch(`/api/task-groups/${group.id}`).send(changes).expect(200);
      expect(updated.body.group).toMatchObject(changes);
      const listed = await request(world.app).get("/api/task-groups").expect(200);
      expect(listed.body.groups[0]).toMatchObject(changes);
      expect((await world.getTask(task.id)).groupId).toBe(group.id);
    },
  },
  {
    id: "TASK-24", title: "replaces a task tag set atomically",
    async run(world) {
      const task = await world.createTask("Retag task");
      const oldTag = await world.createTag("old");
      const newTag = await world.createTag("new");
      await world.assignTaskTags(task.id, [oldTag.id]);
      await world.assignTaskTags(task.id, [newTag.id]);
      const detail = await world.getTask(task.id);
      expect(detail.tags.map((tag: any) => tag.id)).toEqual([newTag.id]);
    },
  },
];
