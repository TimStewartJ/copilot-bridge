// `npm run verify:preview -- --url <previewBaseUrl>`: proves a running staging preview works from the
// outside, the way a person uses it. It reads and writes the preview's API with synthetic fixtures
// it removes again, optionally runs one live chat turn, and screenshots the main screens in a real
// browser at phone and desktop sizes in light and dark theme. `preview:smoke` checks the preview
// machinery itself in-process; this checks a preview that is already being served.
//
// Writes need a staging preview (`/api/server/runtime-status` says `isStaging`); any other Bridge is
// only read, and only with --read-only. Prints a JSON summary and exits non-zero on any failure.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "../shared/is-record.js";
import { ab, isAgentBrowserInstalled, type BrowserCommand, type BrowserCommandOptions } from "./agent-browser.js";
import { BrowserBroker } from "./browser-broker.js";
import {
  buildVerifyPreviewSummary,
  parseVerifyPreviewArgs,
  VERIFY_PREVIEW_USAGE,
  type CheckResult,
  type ScreenshotResult,
  type VerifyPreviewOptions,
} from "./verify-preview-core.js";

const REQUEST_TIMEOUT_MS = 30_000;
const BACKEND_START_WAIT_MS = 120_000;
const CHAT_TIMEOUT_MS = 180_000;
const PAGE_READY_TIMEOUT_MS = 20_000;
const FIXTURE_PREFIX = "verify-preview";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

class SkipCheck extends Error {}

interface ApiResponse {
  status: number;
  json: unknown;
  text: string;
  isJson: boolean;
}

interface Owned {
  taskId?: string;
  checklistItemId?: string;
  docPath?: string;
  sessionId?: string;
  originalTheme?: string;
  /** The theme the preview's settings hold now, while screenshots switch it. */
  currentTheme?: string;
  themeChanged?: boolean;
}

function log(message: string): void {
  process.stderr.write(`[verify-preview] ${message}\n`);
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeText = cause instanceof Error ? cause.message : cause ? String(cause) : "";
  return causeText && !error.message.includes(causeText) ? `${error.message} (${causeText})` : error.message;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${what}: expected a JSON object`);
  return value;
}

function stringField(value: unknown, key: string, what: string): string {
  const field = record(value, what)[key];
  if (typeof field !== "string" || !field) throw new Error(`${what}: expected a string "${key}"`);
  return field;
}

class PreviewClient {
  constructor(private readonly apiBase: string) {}

  url(path: string): string {
    return `${this.apiBase}${path}`;
  }

  async request(method: string, path: string, body?: unknown): Promise<ApiResponse> {
    let response: Response;
    try {
      response = await fetch(this.url(path), {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`${method} ${path}: ${describeError(error)}`);
    }
    const text = await response.text();
    const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
    let json: unknown;
    if (isJson && text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`${method} ${path}: response is not valid JSON`);
      }
    }
    return { status: response.status, json, text, isJson };
  }

  /** A JSON answer with one of the expected statuses, or a readable error. */
  async json(method: string, path: string, body?: unknown, expected: number | number[] = 200): Promise<unknown> {
    const response = await this.request(method, path, body);
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!allowed.includes(response.status)) {
      throw new Error(`${method} ${path}: expected HTTP ${allowed.join("/")}, got ${response.status}: ${response.text.slice(0, 300)}`);
    }
    if (!response.isJson) {
      throw new Error(`${method} ${path}: got ${response.status} with a non-JSON body. Is the preview's backend running?`);
    }
    return response.json;
  }
}

class Checks {
  readonly results: CheckResult[] = [];

  async run<T>(name: string, operation: () => Promise<T | { detail: string; value?: T }>): Promise<T | undefined> {
    const startedAt = Date.now();
    try {
      const outcome = await operation();
      const detail = isRecord(outcome) && typeof outcome.detail === "string" ? outcome.detail : undefined;
      this.results.push({ name, status: "pass", durationMs: Date.now() - startedAt, ...(detail ? { detail } : {}) });
      log(`PASS ${name}${detail ? `: ${detail}` : ""}`);
      return (detail !== undefined ? (outcome as { value?: T }).value : outcome) as T;
    } catch (error) {
      const skipped = error instanceof SkipCheck;
      this.results.push({ name, status: skipped ? "skip" : "fail", durationMs: Date.now() - startedAt, detail: describeError(error) });
      log(`${skipped ? "SKIP" : "FAIL"} ${name}: ${describeError(error)}`);
      return undefined;
    }
  }

  skip(name: string, reason: string): void {
    this.results.push({ name, status: "skip", durationMs: 0, detail: reason });
    log(`SKIP ${name}: ${reason}`);
  }
}

/** What a model costs relative to the others: its premium multiplier, else its token prices. */
function modelCost(model: Record<string, unknown>): number {
  const billing = isRecord(model.billing) ? model.billing : {};
  if (typeof billing.multiplier === "number") return billing.multiplier;
  const prices = isRecord(billing.tokenPrices) ? billing.tokenPrices : {};
  if (typeof prices.inputPrice === "number" && typeof prices.outputPrice === "number") {
    return prices.inputPrice + prices.outputPrice;
  }
  return Number.POSITIVE_INFINITY;
}

/** The model and effort for the chat check: the one asked for, else the cheapest enabled model the preview lists. */
async function chooseChatModel(
  client: PreviewClient,
  requested: string | undefined,
): Promise<{ model?: string; reasoningEffort?: string }> {
  if (requested) return { model: requested };
  const models = record(await client.json("GET", "/models"), "GET /models").models;
  if (!Array.isArray(models)) return {};
  let best: { model: Record<string, unknown>; cost: number } | undefined;
  for (const model of models) {
    if (!isRecord(model) || typeof model.id !== "string") continue;
    // "auto" routes to whichever model the service picks, so its cost is not known in advance.
    if (model.id === "auto") continue;
    if (!isRecord(model.policy) || model.policy.state !== "enabled") continue;
    const cost = modelCost(model);
    if (cost === Number.POSITIVE_INFINITY) continue;
    if (!best || cost < best.cost) best = { model, cost };
  }
  if (!best) return {};
  const efforts = best.model.supportedReasoningEfforts;
  return {
    model: String(best.model.id),
    ...(Array.isArray(efforts) && efforts.includes("low") ? { reasoningEffort: "low" } : {}),
  };
}

/** Follows the session's event stream until its run ends. Returns the event types seen. */
async function waitForRunEnd(client: PreviewClient, sessionId: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("the chat turn did not finish in time")), CHAT_TIMEOUT_MS);
  const types: string[] = [];
  try {
    const response = await fetch(client.url(`/sessions/${sessionId}/stream`), { signal: controller.signal });
    if (response.status !== 200 || !response.body) throw new Error(`stream answered HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("the stream closed before the run ended");
      pending += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) !== -1) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const event = record(JSON.parse(data), "stream event");
        const type = String(event.type);
        types.push(type);
        if (type === "error" || type === "shutdown" || type === "aborted") {
          throw new Error(`the run ended with ${type}: ${String(event.message ?? event.content ?? "")}`.trim());
        }
        // The message was delivered before the stream opened, so a complete snapshot means the run ended.
        if (type === "done" || (type === "snapshot" && event.complete === true)) {
          await reader.cancel().catch(() => undefined);
          return types;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** What a page shows: whether React rendered into #root, and any crash text. */
const PAGE_STATE_SCRIPT = `(() => {
  const root = document.getElementById("root");
  const text = (document.body && document.body.innerText || "").trim();
  const crash = text.match(/Unexpected Application Error|Something went wrong|Staging preview not found|Cannot GET \\//i);
  return JSON.stringify({
    rootChildren: root ? root.childElementCount : -1,
    textLength: root ? (root.innerText || "").trim().length : 0,
    theme: document.documentElement.getAttribute("data-theme"),
    crash: crash ? crash[0] : null,
  });
})()`;

interface PageState {
  rootChildren: number;
  textLength: number;
  theme: string | null;
  crash: string | null;
}

interface ScreenPlan {
  name: string;
  path: string;
}

async function captureScreens(input: {
  options: VerifyPreviewOptions;
  client: PreviewClient;
  checks: Checks;
  outDir: string;
  owned: Owned;
  pages: ScreenPlan[];
  savedTheme: string | undefined;
  screenshots: ScreenshotResult[];
}): Promise<void> {
  const { options, client, checks, outDir, owned, pages, savedTheme, screenshots } = input;
  if (!(await isAgentBrowserInstalled())) {
    if (options.requireScreens) {
      await checks.run("screenshots", async () => {
        throw new Error("agent-browser not found on PATH (--require-screens)");
      });
    } else {
      checks.skip("screenshots", "agent-browser not found");
    }
    return;
  }

  const browserHome = await mkdtemp(join(tmpdir(), "bridge-verify-browser-"));
  const broker = new BrowserBroker({ copilotHome: browserHome, publicConcurrency: 1 });
  try {
    await broker.withEphemeralContext("public", { toolName: "verify_preview", browserOpId: randomUUID() }, async (lease) => {
      const commandOptions: BrowserCommandOptions = { toolName: "verify_preview", browserTarget: lease.browserTarget };
      const command = async (args: BrowserCommand, timeout = 60_000) => {
        const result = await ab(args, timeout, commandOptions);
        if (!result.ok) throw new Error(`agent-browser ${args[0]} failed: ${result.output.slice(0, 300)}`);
        return result.output;
      };

      for (const theme of THEMES) {
        const how = await applyTheme({ options, client, owned, savedTheme, theme, command });
        if (how === "unavailable") {
          checks.skip(`screens ${theme}`, `--read-only keeps the saved theme (${savedTheme ?? "unknown"})`);
          continue;
        }
        for (const viewport of VIEWPORTS) {
          await command(["set", "viewport", String(viewport.width), String(viewport.height)]);
          for (const page of pages) {
            const fileName = `${page.name}-${viewport.name}-${theme}.png`;
            const filePath = join(outDir, fileName);
            await checks.run(`screen ${page.name} ${viewport.name} ${theme}`, async () => {
              const pageUrl = new URL(page.path.replace(/^\//, ""), options.baseUrl).toString();
              // A busy shared server occasionally misses agent-browser's 30-second read; one retry covers it.
              await command(["open", pageUrl]).catch(async (error: unknown) => {
                log(`open ${page.name} failed once, retrying: ${describeError(error).slice(0, 120)}`);
                await command(["open", pageUrl]);
              });
              const state = await waitForPage(command, theme);
              await command(["screenshot", filePath]);
              screenshots.push({ page: page.name, viewport: viewport.name, theme, path: filePath });
              return { detail: `${fileName} (${state.textLength} chars of text)` };
            });
          }
        }
      }
    });
  } catch (error) {
    await checks.run("screenshots", async () => {
      throw error;
    });
  } finally {
    await rm(browserHome, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  }
}

async function applyTheme(input: {
  options: VerifyPreviewOptions;
  client: PreviewClient;
  owned: Owned;
  savedTheme: string | undefined;
  theme: Theme;
  command: (args: BrowserCommand) => Promise<string>;
}): Promise<"setting" | "media" | "unavailable"> {
  const { options, client, owned, savedTheme, theme, command } = input;
  if (savedTheme === "system") {
    await command(["set", "media", theme]);
    return "media";
  }
  if ((owned.currentTheme ?? savedTheme) === theme) return "setting";
  if (options.readOnly) return "unavailable";
  // The preview's settings are its own copy; the original value is put back during cleanup.
  await client.json("PATCH", "/settings", { theme });
  owned.currentTheme = theme;
  owned.themeChanged = true;
  return "setting";
}

async function waitForPage(command: (args: BrowserCommand) => Promise<string>, theme: Theme): Promise<PageState> {
  const deadline = Date.now() + PAGE_READY_TIMEOUT_MS;
  let state: PageState | undefined;
  while (Date.now() < deadline) {
    await delay(750);
    state = JSON.parse(await command(["eval", PAGE_STATE_SCRIPT])) as PageState;
    if (state.crash) throw new Error(`page shows "${state.crash}"`);
    if (state.rootChildren > 0 && state.textLength > 0 && state.theme === theme) {
      // Let late data and transitions land before the picture.
      await delay(750);
      return state;
    }
  }
  if (!state || state.rootChildren <= 0 || state.textLength === 0) throw new Error("page stayed blank (#root rendered nothing)");
  throw new Error(`page theme stayed "${state.theme}" instead of "${theme}"`);
}

async function cleanup(client: PreviewClient, checks: Checks, owned: Owned): Promise<void> {
  if (owned.themeChanged && owned.originalTheme) {
    await checks.run("cleanup: restore theme", async () => {
      await client.json("PATCH", "/settings", { theme: owned.originalTheme });
    });
  }
  if (owned.sessionId) {
    const sessionId = owned.sessionId;
    await checks.run("cleanup: delete chat session", async () => {
      await client.json("DELETE", `/sessions/${sessionId}`);
    });
  }
  if (owned.checklistItemId) {
    const itemId = owned.checklistItemId;
    await checks.run("cleanup: delete checklist item", async () => {
      await client.json("DELETE", `/checklist-items/${itemId}`);
    });
  }
  if (owned.docPath) {
    const docPath = owned.docPath;
    await checks.run("cleanup: delete docs page", async () => {
      await client.json("DELETE", `/docs/pages/${docPath}`);
      const after = await client.request("GET", `/docs/pages/${docPath}`);
      if (after.status !== 404) throw new Error(`page still readable (HTTP ${after.status})`);
    });
  }
  if (owned.taskId) {
    const taskId = owned.taskId;
    await checks.run("cleanup: delete task", async () => {
      await client.json("DELETE", `/tasks/${taskId}`);
      const after = await client.request("GET", `/tasks/${taskId}`);
      if (after.status !== 404) throw new Error(`task still readable (HTTP ${after.status})`);
    });
  }
}

async function verify(options: VerifyPreviewOptions, outDir: string): Promise<{ checks: Checks; screenshots: ScreenshotResult[] }> {
  const client = new PreviewClient(options.apiBase);
  const checks = new Checks();
  const screenshots: ScreenshotResult[] = [];
  const owned: Owned = {};
  const nonce = randomUUID().slice(0, 8);

  const health = await checks.run("health", async () => {
    // A preview's backend starts lazily on the first request and answers 503 with retryAfterSeconds meanwhile.
    const deadline = Date.now() + BACKEND_START_WAIT_MS;
    for (;;) {
      const response = await client.request("GET", "/health");
      const retryAfter = response.status === 503 && isRecord(response.json) && typeof response.json.retryAfterSeconds === "number"
        ? response.json.retryAfterSeconds
        : undefined;
      if (retryAfter === undefined || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(retryAfter, 1), 10) * 1000));
    }
    const body = record(await client.json("GET", "/health"), "GET /health");
    if (body.ok !== true) throw new Error("GET /health did not report ok");
    const backend = isRecord(body.agentBackend) ? body.agentBackend : {};
    return { detail: `agent backend ${String(backend.state ?? "unknown")}`, value: body };
  });
  if (!health) {
    checks.skip("remaining checks", "the preview did not answer its health check");
    return { checks, screenshots };
  }

  const isStaging = await checks.run("runtime status", async () => {
    const body = record(await client.json("GET", "/server/runtime-status"), "GET /server/runtime-status");
    const staging = body.isStaging === true;
    if (!staging && !options.readOnly) {
      throw new Error("this Bridge is not a staging preview; refusing to write fixtures. Point --url at a preview or pass --read-only");
    }
    return { detail: staging ? "staging preview" : "not a staging preview (read-only run)", value: staging };
  });
  if (isStaging === undefined) {
    checks.skip("remaining checks", "the target could not be confirmed as a staging preview");
    return { checks, screenshots };
  }
  const writable = isStaging && !options.readOnly;

  try {
    const settings = await checks.run("settings read", async () => {
      const body = record(await client.json("GET", "/settings"), "GET /settings");
      return { detail: `theme ${String(body.theme ?? "default")}`, value: body };
    });
    owned.originalTheme = typeof settings?.theme === "string" ? settings.theme : "dark";

    await checks.run("skills list", async () => {
      const skills = record(await client.json("GET", "/skills"), "GET /skills").skills;
      if (!Array.isArray(skills)) throw new Error("GET /skills: expected a skills array");
      return { detail: `${skills.length} skills` };
    });

    await checks.run("playbooks catalog", async () => {
      const response = await client.request("GET", "/playbooks");
      if (response.status === 404 || !response.isJson) throw new SkipCheck("GET /playbooks is not served by this build");
      if (response.status !== 200) throw new Error(`GET /playbooks: HTTP ${response.status}: ${response.text.slice(0, 200)}`);
      const body = response.json;
      const list = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.playbooks) ? body.playbooks : undefined;
      if (!list) throw new Error("GET /playbooks: expected a playbooks array");
      return { detail: `${list.length} playbooks` };
    });

    const existingSessionId = await checks.run("sessions list", async () => {
      const sessions = record(await client.json("GET", "/sessions"), "GET /sessions").sessions;
      if (!Array.isArray(sessions)) throw new Error("GET /sessions: expected a sessions array");
      const first = sessions.find((session) => isRecord(session) && typeof session.sessionId === "string");
      return { detail: `${sessions.length} sessions`, value: isRecord(first) ? String(first.sessionId) : undefined };
    });

    if (existingSessionId) {
      await checks.run("defers list", async () => {
        const defers = record(await client.json("GET", `/sessions/${existingSessionId}/defers`), "GET defers").defers;
        if (!Array.isArray(defers)) throw new Error("GET /sessions/:id/defers: expected a defers array");
        return { detail: `${defers.length} defers on one existing session` };
      });
    } else {
      checks.skip("defers list", "the preview has no sessions to list defers for");
    }

    let taskId: string | undefined;
    if (writable) {
      taskId = await checks.run("task create and update", async () => {
        const created = record(await client.json("POST", "/tasks", { title: `${FIXTURE_PREFIX} ${nonce}` }), "POST /tasks").task;
        const id = stringField(created, "id", "POST /tasks task");
        owned.taskId = id;
        const notes = `Synthetic ${FIXTURE_PREFIX} fixture ${nonce}; removed when the run ends.`;
        await client.json("PATCH", `/tasks/${id}`, { notes });
        const loaded = record(record(await client.json("GET", `/tasks/${id}`), "GET /tasks/:id").task, "GET /tasks/:id task");
        if (loaded.notes !== notes) throw new Error("the task's notes did not read back");
        return { detail: id, value: id };
      });
    } else {
      taskId = await checks.run("tasks list", async () => {
        const tasks = record(await client.json("GET", "/tasks"), "GET /tasks").tasks;
        if (!Array.isArray(tasks)) throw new Error("GET /tasks: expected a tasks array");
        const first = tasks.find((task) => isRecord(task) && typeof task.id === "string");
        return { detail: `${tasks.length} tasks`, value: isRecord(first) ? String(first.id) : undefined };
      });
    }

    if (taskId) {
      const scheduleTaskId = taskId;
      await checks.run("schedules list", async () => {
        const schedules = await client.json("GET", `/schedules?taskId=${encodeURIComponent(scheduleTaskId)}`);
        if (!Array.isArray(schedules)) throw new Error("GET /schedules: expected an array");
        return { detail: `${schedules.length} schedules on the task` };
      });
    } else {
      checks.skip("schedules list", "no task to list schedules for");
    }

    if (writable && owned.taskId) {
      const fixtureTaskId = owned.taskId;
      await checks.run("checklist add and remove", async () => {
        const created = record(
          await client.json("POST", `/tasks/${fixtureTaskId}/checklist-items`, { text: `${FIXTURE_PREFIX} item ${nonce}` }),
          "POST checklist item",
        ).checklistItem;
        const itemId = stringField(created, "id", "POST checklist item");
        owned.checklistItemId = itemId;
        const listed = record(await client.json("GET", `/tasks/${fixtureTaskId}/checklist-items`), "GET checklist").checklistItems;
        if (!Array.isArray(listed) || !listed.some((item) => isRecord(item) && item.id === itemId)) {
          throw new Error("the new checklist item is not listed");
        }
        await client.json("DELETE", `/checklist-items/${itemId}`);
        owned.checklistItemId = undefined;
        const after = record(await client.json("GET", `/tasks/${fixtureTaskId}/checklist-items`), "GET checklist").checklistItems;
        if (Array.isArray(after) && after.some((item) => isRecord(item) && item.id === itemId)) {
          throw new Error("the checklist item is still listed after delete");
        }
      });

      await checks.run("docs page write and read", async () => {
        const docPath = `${FIXTURE_PREFIX}/${nonce}`;
        const marker = `${FIXTURE_PREFIX}-marker-${nonce}`;
        const content = `---\ntitle: Verify preview ${nonce}\ndescription: Synthetic fixture page.\n---\n\n${marker}\n`;
        await client.json("PUT", `/docs/pages/${docPath}`, { content });
        owned.docPath = docPath;
        const page = await client.json("GET", `/docs/pages/${docPath}`);
        if (!JSON.stringify(page).includes(marker)) throw new Error("the page did not read back");
        return { detail: docPath };
      });
    } else if (!writable) {
      checks.skip("fixture writes", "read-only run");
    }

    if (options.chat) {
      await checks.run("chat turn", async () => {
        const selection = await chooseChatModel(client, options.model);
        const created = await client.json("POST", "/sessions", selection);
        const sessionId = stringField(created, "sessionId", "POST /sessions");
        owned.sessionId = sessionId;
        const token = `${FIXTURE_PREFIX}-ok-${nonce}`;
        await client.json("POST", "/chat", {
          sessionId,
          prompt: `This is an automated check. Reply with exactly this text and nothing else: ${token}`,
          mode: "interactive",
          waitForDelivery: true,
          clientMessageId: randomUUID(),
        }, 202);
        const events = await waitForRunEnd(client, sessionId);
        const history = record(await client.json("GET", `/sessions/${sessionId}/messages-fast?limit=50`), "GET messages").messages;
        const replies = Array.isArray(history)
          ? history.filter((message) => isRecord(message) && message.role === "assistant" && typeof message.content === "string")
          : [];
        const reply = replies.at(-1) as Record<string, unknown> | undefined;
        if (!reply) throw new Error("no assistant reply was persisted");
        if (!String(reply.content).includes(token)) throw new Error(`the persisted reply does not contain ${token}`);
        const modelLabel = selection.model
          ? `${selection.model}${selection.reasoningEffort ? ` (${selection.reasoningEffort} effort)` : ""}`
          : "default model";
        return { detail: `${modelLabel}; ${events.length} stream events; reply persisted` };
      });
    }

    if (options.screens) {
      const chatSessionId = owned.sessionId ?? existingSessionId;
      const pages: ScreenPlan[] = [
        { name: "home", path: "/dashboard/home" },
        { name: "tasks", path: "/" },
        ...(taskId ? [{ name: "task", path: `/tasks/${encodeURIComponent(taskId)}` }] : []),
        ...(chatSessionId ? [{ name: "chat", path: `/sessions/${encodeURIComponent(chatSessionId)}` }] : []),
        { name: "docs", path: owned.docPath ? `/docs/${owned.docPath}` : "/docs" },
        { name: "settings", path: "/settings" },
      ];
      await captureScreens({ options, client, checks, outDir, owned, pages, savedTheme: owned.originalTheme, screenshots });
    } else {
      checks.skip("screenshots", "--no-screens");
    }
  } finally {
    await cleanup(client, checks, owned);
  }
  return { checks, screenshots };
}

async function main(): Promise<number> {
  const parsed = parseVerifyPreviewArgs(process.argv.slice(2));
  if (!parsed.ok) {
    if ("help" in parsed) {
      process.stdout.write(`${VERIFY_PREVIEW_USAGE}\n`);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n\n${VERIFY_PREVIEW_USAGE}\n`);
    return 2;
  }
  const { options } = parsed;
  const outDir = options.outDir ? resolve(options.outDir) : await mkdtemp(join(tmpdir(), "bridge-verify-preview-"));
  await mkdir(outDir, { recursive: true });

  // The browser helpers log progress to stdout; the summary JSON owns stdout.
  console.log = (...args: unknown[]) => console.error(...args);

  const startedAt = new Date();
  log(`verifying ${options.baseUrl}; output in ${outDir}`);
  const { checks, screenshots } = await verify(options, outDir);
  const summary = buildVerifyPreviewSummary({
    options,
    outDir,
    startedAt,
    finishedAt: new Date(),
    checks: checks.results,
    screenshots,
  });
  const json = JSON.stringify(summary, null, 2);
  await writeFile(join(outDir, "summary.json"), `${json}\n`);
  await new Promise<void>((done) => process.stdout.write(`${json}\n`, () => done()));
  log(`${summary.ok ? "OK" : "FAILED"}: ${summary.counts.pass} passed, ${summary.counts.fail} failed, ${summary.counts.skip} skipped; summary at ${join(outDir, "summary.json")}`);
  return summary.ok ? 0 : 1;
}

// Exit once the event loop drains: process.exit with fetch's keep-alive sockets still open can crash
// Node on Windows. The timer only fires if something (a browser helper) keeps the loop alive.
main().then(
  (code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 5_000).unref();
  },
  (error) => {
    process.stderr.write(`[verify-preview] crashed: ${describeError(error)}\n`);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 5_000).unref();
  },
);
