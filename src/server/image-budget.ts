import type {
  AgentBackgroundTask,
  AgentCompactionResult,
  AgentCurrentModel,
  AgentSessionActivity,
} from "./agent-backend/types.js";
import { readJsonlLines } from "./jsonl-lines.js";
import { getSdkAgentId } from "./sdk-event-identity.js";
import { imageCompactAtBytes, type ImageBudgetSettings } from "../shared/image-budget.js";

/**
 * Keeps a conversation on a model with a request-size ceiling (setting `imageBudget`, default claude-* at 30 MB)
 * from growing past it with images.
 *
 * Why: Copilot sometimes serves Claude through Google Vertex, which rejects requests over about 30 MB with a
 * bodyless 400. Copilot CLI 1.0.88 compacts and retries only on a 413, so the chat is stuck for good; even /compact
 * fails, because the summary request carries the same images.
 *
 * Remove this module (and its hooks in SessionManager and SessionRunner) once Copilot returns a 413 for these
 * requests, or the CLI counts image bytes when it decides to compact. `image-budget.native.test.ts` starts failing
 * when the CLI recovers by itself.
 *
 * How: estimate the images in the main conversation from session events. The runtime does not report which images
 * are still in context, so the estimate errs high: it adds every image a main-agent tool result or user message
 * carried, and a successful compaction removes what existed when it started. At two thirds of the ceiling the turn is
 * stopped at a tool boundary, compacted and continued, because the runtime applies a compaction only when a new
 * message starts a run.
 */

type ImageBudgetRecord =
  | { kind: "images"; id?: string; bytes: number }
  | { kind: "compaction-start"; id?: string }
  | { kind: "compaction-end"; id?: string; success: boolean }
  | { kind: "model"; id?: string; model: string };

export interface ImageBudgetState {
  /** Base64 characters of image data in the conversation, which is what each request carries. */
  bytes: number;
  compactionsInFlight: number;
  bytesAtCompactionStart?: number;
  model?: string;
}

const EMPTY_STATE: ImageBudgetState = Object.freeze({ bytes: 0, compactionsInFlight: 0 });

export const IMAGE_BUDGET_COMPACTION_INSTRUCTIONS =
  "Images viewed so far will be removed from the conversation. For each image that still matters, keep its file path or source and what it showed or what was concluded from it, so it can be viewed again if needed.";

export const IMAGE_PAUSE_CONTINUE_PROMPT = [
  "<bridge_notice>",
  "Bridge paused your previous turn to summarize the images in this conversation, because this model's provider rejects requests carrying much more image data. The summary replaced the earlier images.",
  "Continue from where you left off. View an image again if you still need to see it. If the previous request was already complete, briefly confirm that and stop.",
  "</bridge_notice>",
].join("\n");

const UNCOMPACTED_CONTINUE_PROMPT = [
  "<bridge_notice>",
  "Bridge paused your previous turn to summarize the images in this conversation, but the summary failed, so they are still there. This model's provider rejects requests carrying much more image data.",
  "Continue from where you left off and avoid viewing more large images. If the previous request was already complete, briefly confirm that and stop.",
  "</bridge_notice>",
].join("\n");

/** After an attempt, the estimate must grow this much before the next one, so a high estimate cannot loop. */
const REARM_GROWTH_BYTES = 2_000_000;
/** Consecutive failed attempts after which a session is no longer paused. */
const MAX_CONSECUTIVE_FAILURES = 2;
/** How long a pause waits for the stopped turn to end. */
const SETTLE_TIMEOUT_MS = 30_000;
/** How long a pause waits for a compaction the runtime started itself (the compaction RPC's own bound). */
const COMPACTION_TIMEOUT_MS = 10 * 60_000;

/** Sub-agents keep their own conversation; their events carry an agent id and a parent tool call. */
function isMainAgentEvent(event: unknown): boolean {
  if (!event || typeof event !== "object" || getSdkAgentId(event)) return false;
  return typeof (event as { data?: { parentToolCallId?: unknown } }).data?.parentToolCallId !== "string";
}

/** Live events carry base64 `data`; events.jsonl keeps only the decoded `byteLength`. */
function base64Bytes(items: unknown, onlyBlobs = false): number {
  if (!Array.isArray(items)) return 0;
  let bytes = 0;
  for (const item of items as Array<{ type?: unknown; data?: unknown; byteLength?: unknown }>) {
    if (!item || (onlyBlobs && item.type !== "blob")) continue;
    if (typeof item.data === "string") bytes += item.data.length;
    else if (typeof item.byteLength === "number" && item.byteLength > 0) bytes += Math.ceil(item.byteLength / 3) * 4;
  }
  return bytes;
}

function toRecord(event: unknown): ImageBudgetRecord | undefined {
  if (!isMainAgentEvent(event)) return undefined;
  const { type, id: rawId, data } = event as { type?: unknown; id?: unknown; data?: any };
  const id = typeof rawId === "string" ? rawId : undefined;
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  let bytes = 0;
  switch (type) {
    case "tool.execution_complete":
      bytes = base64Bytes(data?.result?.binaryResultsForLlm);
      return bytes > 0 ? { kind: "images", id, bytes } : undefined;
    case "user.message":
      bytes = base64Bytes(data?.attachments, true);
      return bytes > 0 ? { kind: "images", id, bytes } : undefined;
    case "session.compaction_start":
      return { kind: "compaction-start", id };
    case "session.compaction_complete":
      return { kind: "compaction-end", id, success: data?.success === true };
    case "session.start":
    case "session.resume": {
      const model = text(data?.selectedModel);
      return model ? { kind: "model", id, model } : undefined;
    }
    case "session.model_change": {
      const model = text(data?.newModel);
      return model ? { kind: "model", id, model } : undefined;
    }
    default:
      return undefined;
  }
}

function applyRecord(state: ImageBudgetState, record: ImageBudgetRecord): ImageBudgetState {
  switch (record.kind) {
    case "images":
      return { ...state, bytes: state.bytes + record.bytes };
    case "compaction-start":
      return {
        ...state,
        compactionsInFlight: state.compactionsInFlight + 1,
        // With overlapping compactions only the first one's starting point is known to be removed.
        bytesAtCompactionStart: state.compactionsInFlight === 0 ? state.bytes : state.bytesAtCompactionStart,
      };
    case "compaction-end": {
      const compactionsInFlight = Math.max(0, state.compactionsInFlight - 1);
      const removed = record.success ? state.bytesAtCompactionStart ?? 0 : 0;
      const keepStart = !record.success && compactionsInFlight > 0;
      return {
        ...state,
        compactionsInFlight,
        bytes: Math.max(0, state.bytes - removed),
        bytesAtCompactionStart: keepStart ? state.bytesAtCompactionStart : undefined,
      };
    }
    case "model":
      return { ...state, model: record.model };
  }
}

const RELEVANT_TYPES = [
  "tool.execution_complete", "user.message", "session.compaction_start", "session.compaction_complete",
  "session.start", "session.resume", "session.model_change",
].map((type) => `"${type}"`);

/** Rebuilds the estimate from events.jsonl without parsing the large image-asset lines. */
export async function readImageBudgetFromEvents(eventsPath: string): Promise<{ state: ImageBudgetState; eventIds: Set<string> }> {
  let state = EMPTY_STATE;
  const eventIds = new Set<string>();
  try {
    for await (const line of readJsonlLines(eventsPath)) {
      const head = line.slice(0, 200);
      if (head.includes("\"session.binary_asset\"") || !RELEVANT_TYPES.some((type) => head.includes(type))) continue;
      let record: ImageBudgetRecord | undefined;
      try { record = toRecord(JSON.parse(line)); } catch { continue; }
      if (!record) continue;
      state = applyRecord(state, record);
      if (record.id) eventIds.add(record.id);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  // A compaction that started before the runtime last stopped never finished.
  return { state: { ...state, compactionsInFlight: 0, bytesAtCompactionStart: undefined }, eventIds };
}

/** The parts of a live session the budget uses. */
export interface ImageBudgetSession {
  getCurrentModel?(): Promise<AgentCurrentModel | undefined>;
  compactHistory?(opts?: { customInstructions?: string }): Promise<AgentCompactionResult | undefined>;
  getActivity?(): Promise<AgentSessionActivity | undefined>;
  listTasks?(): Promise<{ tasks?: AgentBackgroundTask[] } | undefined>;
  on?(handler: (event: any) => void): () => void;
}

/** What SessionManager provides so a pause cannot race other work on the session. */
export interface ImageBudgetHost {
  getSettings(): ImageBudgetSettings | undefined;
  getEventsPath(sessionId: string): string;
  /** Takes the session so nothing else starts or steers a turn; false when it is busy with something else. */
  hold(sessionId: string): boolean;
  /** Whether a turn is running, and whether Bridge may stop it (not automated quiet turns or Helm). */
  runningTurn(sessionId: string): "none" | "stoppable" | "keep";
  /** Stops the running turn without counting as the user's Stop, and resolves once Bridge's run for it has ended. */
  stopTurn(sessionId: string): Promise<void>;
  /**
   * In one step: drops what the stopped turn left behind, releases the session, and starts the continuation (only if
   * `session` is still the cached handle). `attention` asks the user to look at a turn that was stopped but not continued.
   */
  finish(sessionId: string, session: ImageBudgetSession, outcome: FinishOutcome): void;
  recordSpan?(name: string, duration: number, sessionId: string, metadata: Record<string, unknown>): void;
}

export interface FinishOutcome {
  stopped: boolean;
  /** The notice that continues the stopped turn, in the session's current send mode. */
  continuation?: { prompt: string };
  attention?: boolean;
}

type Outcome = "compacted" | "failed" | "skipped";
type Trigger = "tool-boundary" | "idle";

interface Entry {
  session: ImageBudgetSession;
  state: ImageBudgetState;
  loading: boolean;
  queued: ImageBudgetRecord[];
  runningTools: Set<string>;
  pausing: boolean;
  modelLookupStarted: boolean;
}

export class ImageBudgetController {
  private readonly entries = new Map<string, Entry>();
  /** Kept per session id, so a reload or a new handle cannot reset them into a loop. */
  private readonly guards = new Map<string, { failures: number; rearmAt?: number }>();
  /** Pauses in progress; the user's Stop cancels the continuation. */
  private readonly pauses = new Map<string, { cancelled: boolean }>();

  constructor(private readonly host: ImageBudgetHost) {}

  /** Starts tracking a session handle that was just cached. */
  attach(sessionId: string, session: ImageBudgetSession): void {
    if (this.entries.get(sessionId)?.session !== session) this.load(sessionId, session);
  }

  detach(sessionId: string, session: ImageBudgetSession): void {
    if (this.entries.get(sessionId)?.session === session) this.entries.delete(sessionId);
  }

  /** Rebuilds the estimate after the persisted history was cut back (undo, quiet-tail truncation). */
  reload(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) this.load(sessionId, entry.session);
  }

  forget(sessionId: string): void {
    this.entries.delete(sessionId);
    this.guards.delete(sessionId);
  }

  isPausing(sessionId: string): boolean {
    return this.pauses.has(sessionId);
  }

  /** The user stopped the chat: a pause in progress must not continue the turn. */
  cancelPause(sessionId: string): boolean {
    const pause = this.pauses.get(sessionId);
    if (pause) pause.cancelled = true;
    return Boolean(pause);
  }

  observe(sessionId: string, session: ImageBudgetSession, event: unknown): void {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.session !== session) return;
    const boundary = this.trackTools(entry, event);
    const record = toRecord(event);
    if (entry.loading) {
      if (record) entry.queued.push(record);
      return;
    }
    if (record) entry.state = applyRecord(entry.state, record);
    if (boundary) this.maybePause(sessionId, entry, "tool-boundary");
    else if (record?.kind === "model" || record?.kind === "images") this.maybePause(sessionId, entry, "idle");
  }

  /** Called once the session stops being busy, for images a turn without tool calls added. */
  sessionIdle(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry && entry.runningTools.size === 0) this.maybePause(sessionId, entry, "idle");
  }

  /** True when a main-agent tool finished and none is still running: the turn can stop here. */
  private trackTools(entry: Entry, event: unknown): boolean {
    if (!isMainAgentEvent(event)) return false;
    const { type, data } = event as { type?: unknown; data?: { toolCallId?: unknown } };
    const toolCallId = typeof data?.toolCallId === "string" ? data.toolCallId : undefined;
    if (type === "tool.execution_start" && toolCallId) entry.runningTools.add(toolCallId);
    if (type === "session.idle" || type === "abort") entry.runningTools.clear();
    if (type !== "tool.execution_complete") return false;
    if (toolCallId) entry.runningTools.delete(toolCallId);
    return entry.runningTools.size === 0;
  }

  private load(sessionId: string, session: ImageBudgetSession): void {
    const entry: Entry = {
      session, state: EMPTY_STATE, loading: true, queued: [], runningTools: new Set(), pausing: false, modelLookupStarted: false,
    };
    this.entries.set(sessionId, entry);
    const finish = (replay: { state: ImageBudgetState; eventIds: Set<string> }) => {
      if (this.entries.get(sessionId) !== entry) return;
      entry.state = replay.state;
      // Events that arrived during the read may also have been written before it reached them.
      for (const record of entry.queued) {
        if (!record.id || !replay.eventIds.has(record.id)) entry.state = applyRecord(entry.state, record);
      }
      entry.queued = [];
      entry.loading = false;
      if (entry.runningTools.size === 0) this.maybePause(sessionId, entry, "idle");
    };
    void readImageBudgetFromEvents(this.host.getEventsPath(sessionId)).then(finish, (error) => {
      console.warn(`[image-budget] [${sessionId.slice(0, 8)}] Could not read session events:`, error instanceof Error ? error.message : error);
      finish({ state: EMPTY_STATE, eventIds: new Set() });
    });
  }

  private maybePause(sessionId: string, entry: Entry, trigger: Trigger): void {
    if (entry.loading || entry.pausing) return;
    const guard = this.guards.get(sessionId) ?? { failures: 0 };
    if (guard.failures >= MAX_CONSECUTIVE_FAILURES) return;
    if (!entry.state.model) {
      // A new chat's log has no model yet when tracking starts; ask once it has images.
      if (entry.state.bytes > 0) this.lookUpModel(sessionId, entry, trigger);
      return;
    }
    const threshold = imageCompactAtBytes(entry.state.model, this.host.getSettings());
    if (threshold === undefined || entry.state.compactionsInFlight > 0) return;
    if (entry.state.bytes < Math.max(threshold, guard.rearmAt ?? 0)) return;

    entry.pausing = true;
    void this.pause(sessionId, entry, trigger).catch(() => "failed" as const).then((outcome) => {
      if (this.entries.get(sessionId) === entry) entry.pausing = false;
      if (outcome === "skipped") return;
      const current = this.entries.get(sessionId) ?? entry;
      this.guards.set(sessionId, {
        failures: outcome === "compacted" ? 0 : guard.failures + 1,
        rearmAt: current.state.bytes + REARM_GROWTH_BYTES,
      });
    });
  }

  private async pause(sessionId: string, entry: Entry, trigger: Trigger): Promise<Outcome> {
    const { session } = entry;
    const running = this.host.runningTurn(sessionId);
    // An idle signal can race the end of a run; the run's next tool boundary asks again.
    if (running === "keep" || (trigger === "idle" && running !== "none")) return "skipped";
    if (typeof session.compactHistory !== "function" || this.pauses.has(sessionId)) return "skipped";
    // Registered before any await, so the user's Stop or a steer from here on is seen.
    const pause = { cancelled: false };
    this.pauses.set(sessionId, pause);
    const stopped = running === "stoppable";
    const startedAt = Date.now();
    const { bytes, model } = entry.state;
    let held = false;
    let outcome: Outcome = "skipped";
    let detail: string | undefined;
    let compactionAttempted = false;
    let runtimeCompacting = false;
    let unsubscribe: (() => void) | undefined;
    let stoppedTurnIdle: Promise<void> | undefined;
    try {
      if (stopped) {
        // Stopping the turn could cancel a background agent the model is waiting for.
        const tasks = await session.listTasks?.().catch(() => undefined);
        if (tasks?.tasks?.some((task) => task.kind === "agent" && task.status === "running")) return outcome;
        if (this.host.runningTurn(sessionId) !== "stoppable") return outcome;
      }
      if (pause.cancelled || !this.host.hold(sessionId)) return outcome;
      held = true;
      outcome = "failed";
      console.log(`[image-budget] [${sessionId.slice(0, 8)}] About ${(bytes / 1e6).toFixed(1)} MB of images on ${model}; ${stopped ? "pausing the turn to compact" : "compacting"}`);
      if (stopped) {
        // The stopped turn's own idle can arrive only after the compaction; the continuation must start after it.
        stoppedTurnIdle = new Promise<void>((resolve) => {
          unsubscribe = session.on?.((event) => { if (event?.type === "session.idle" && isMainAgentEvent(event)) resolve(); });
        });
        await this.host.stopTurn(sessionId);
        await waitUntilNotProcessing(session);
      }
      if (pause.cancelled) {
        outcome = "skipped";
        return outcome;
      }
      compactionAttempted = true;
      const result = await session.compactHistory({ customInstructions: IMAGE_BUDGET_COMPACTION_INSTRUCTIONS });
      outcome = result?.success ? "compacted" : "failed";
    } catch (error) {
      detail = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      // The runtime's own compaction is already shrinking the conversation.
      runtimeCompacting = /already in progress/i.test(detail);
      outcome = runtimeCompacting ? "skipped" : "failed";
      if (!runtimeCompacting) console.warn(`[image-budget] [${sessionId.slice(0, 8)}] Compaction failed: ${detail}`);
    } finally {
      // The idle follows the end of whichever compaction is running, which for the runtime's own can take minutes.
      if (compactionAttempted && stoppedTurnIdle) {
        await Promise.race([stoppedTurnIdle, delay(runtimeCompacting ? COMPACTION_TIMEOUT_MS : SETTLE_TIMEOUT_MS)]);
      }
      unsubscribe?.();
      if (this.pauses.get(sessionId) === pause) this.pauses.delete(sessionId);
      if (held) {
        // A turn is continued only after an attempted compaction; a stop that did not settle is left to the user.
        const continues = stopped && !pause.cancelled && compactionAttempted;
        const summarized = outcome === "compacted" || runtimeCompacting;
        this.host.finish(sessionId, session, {
          stopped,
          ...(continues ? { continuation: { prompt: summarized ? IMAGE_PAUSE_CONTINUE_PROMPT : UNCOMPACTED_CONTINUE_PROMPT } } : {}),
          ...(stopped && !pause.cancelled && !compactionAttempted ? { attention: true } : {}),
        });
        this.host.recordSpan?.("session.imageBudget.pause", Date.now() - startedAt, sessionId, {
          outcome, stopped, cancelled: pause.cancelled, model, estimatedBytes: bytes, ...(detail ? { detail } : {}),
        });
      }
    }
    return outcome;
  }

  private lookUpModel(sessionId: string, entry: Entry, trigger: Trigger): void {
    if (entry.modelLookupStarted || !entry.session.getCurrentModel) return;
    entry.modelLookupStarted = true;
    void Promise.resolve().then(() => entry.session.getCurrentModel?.()).then((current) => {
      if (this.entries.get(sessionId) !== entry || entry.state.model || !current?.modelId) return;
      entry.state = { ...entry.state, model: current.modelId };
      if (entry.runningTools.size === 0) this.maybePause(sessionId, entry, trigger);
    }, () => { /* the next model event fills it in */ });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

/** Bridge's run can end before the runtime's does; compaction must not race a live turn. */
async function waitUntilNotProcessing(session: ImageBudgetSession): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const activity = await session.getActivity?.().catch(() => undefined);
    if (activity?.processing !== true) return;
    await delay(250);
  }
  throw new Error("the stopped turn did not end in time");
}
