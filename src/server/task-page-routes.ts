// HTTP routes for task pages. The page is agent-written HTML, so it is served in the same sandbox
// as every other HTML document an agent writes.
import type { Router } from "express";
import type { AppContext } from "./app-context.js";
import type { TaskPageStore } from "./task-page-store.js";
import { setHtmlSandboxHeaders } from "./visual-artifacts.js";

type TaskPageContext = Pick<AppContext, "taskStore" | "globalBus"> & { taskPageStore: TaskPageStore };

export function registerTaskPageRoutes(router: Router, ctx: TaskPageContext): void {
  router.get("/tasks/:id/page", (req, res) => {
    if (!ctx.taskStore.getTask(req.params.id)) return res.status(404).json({ error: "Task not found" });
    res.json({ page: ctx.taskPageStore.info(req.params.id) ?? null });
  });

  router.get("/tasks/:id/page.html", (req, res) => {
    const html = ctx.taskPageStore.html(req.params.id);
    if (html === undefined) return res.status(404).json({ error: "This task has no page." });
    setHtmlSandboxHeaders(res);
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(html);
  });

  router.delete("/tasks/:id/page", (req, res) => {
    if (!ctx.taskPageStore.remove(req.params.id)) return res.status(404).json({ error: "This task has no page." });
    ctx.globalBus.emit({ type: "task:changed", taskId: req.params.id });
    res.json({ ok: true });
  });
}
