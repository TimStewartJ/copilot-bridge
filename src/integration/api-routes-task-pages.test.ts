import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBridgeToolDefinitions } from "../server/agent-tools-mcp/register.js";
import { makeTestDir } from "../server/__tests__/helpers.js";
import { MAX_TASK_PAGE_BYTES } from "../server/task-page-store.js";
import { createTestApp, request } from "../test-support/api-routes.js";

const invocation = { sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", toolCallId: "call-1", toolName: "task_page_publish", arguments: {} };

describe("task pages", () => {
  it("publishes a page from a chat, serves it sandboxed, replaces and removes it", async () => {
    const { app, ctx } = createTestApp();
    const publish = getBridgeToolDefinitions(ctx).find((tool) => tool.name === "task_page_publish")!;
    const task = ctx.taskStore.createTask("Example trip");
    const dir = makeTestDir("task-page");
    const file = (name: string, html: string) => { const path = join(dir, name); writeFileSync(path, html); return path; };

    expect((await request(app).get(`/api/tasks/${task.id}/page`).expect(200)).body).toEqual({ page: null });
    await request(app).get(`/api/tasks/${task.id}/page.html`).expect(404);

    const result = await publish.handler({ taskId: task.id, path: file("v1.html", "<h1>Day one</h1>") }, invocation) as any;
    expect(result).toMatchObject({ success: true });
    expect(JSON.stringify(result)).not.toContain("Day one");
    expect((await request(app).get(`/api/tasks/${task.id}/page`).expect(200)).body.page).toMatchObject({ sessionId: invocation.sessionId, size: 16 });

    const page = await request(app).get(`/api/tasks/${task.id}/page.html`).expect(200);
    expect(page.text).toBe("<h1>Day one</h1>");
    expect(page.headers["content-security-policy"]).toContain("sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;");
    expect(page.headers["content-security-policy"]).toContain("connect-src 'none'");

    await publish.handler({ taskId: task.id, path: file("v2.html", "<h1>Day two</h1>") }, invocation);
    expect((await request(app).get(`/api/tasks/${task.id}/page.html`)).text).toBe("<h1>Day two</h1>");

    const tooBig = await publish.handler({ taskId: task.id, path: file("big.html", "x".repeat(MAX_TASK_PAGE_BYTES + 1)) }, invocation) as any;
    expect(JSON.stringify(tooBig)).toContain("larger than");
    const missing = await publish.handler({ taskId: task.id, path: join(dir, "nope.html") }, invocation) as any;
    expect(JSON.stringify(missing)).toContain("not found");
    expect((await request(app).get(`/api/tasks/${task.id}/page.html`)).text).toBe("<h1>Day two</h1>");

    await request(app).delete(`/api/tasks/${task.id}/page`).expect(200);
    await request(app).delete(`/api/tasks/${task.id}/page`).expect(404);

    await publish.handler({ taskId: task.id, path: file("v3.html", "<h1>Again</h1>") }, invocation);
    ctx.taskStore.deleteTask(task.id);
    expect(ctx.taskPageStore!.info(task.id)).toBeUndefined();
  });
});
