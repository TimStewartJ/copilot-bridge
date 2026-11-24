import { randomUUID } from "node:crypto";
import type { SessionEvent } from "@github/copilot-sdk";
import { isRecord } from "../shared/is-record.js";
import { MAX_IDLE_PASSES, type CustomAutopilot, type CustomAutopilotProgress } from "../shared/send-mode.js";

/** An automation turn starts an Autopilot request, so the runtime reports when it stops. */
export const CUSTOM_CONTINUATION_SOURCE = "automation-bridge-custom-autopilot";

/** Bridge's mark on its keep-going prompts; the runtime saves it on the message as clientTurnId. */
const CONTINUATION_TURN_PREFIX = "bridge-custom-autopilot:";

export function newContinuationTurnId(): string {
  return `${CONTINUATION_TURN_PREFIX}${randomUUID()}`;
}

/** A keep-going prompt Bridge sent, known by the id it set, not by its text. */
export function isCustomContinuationMessage(event: unknown): boolean {
  if (!isRecord(event) || event.type !== "user.message" || !isRecord(event.data)) return false;
  const turnId = event.data.clientTurnId;
  return typeof turnId === "string" && turnId.startsWith(CONTINUATION_TURN_PREFIX);
}

/** Keep-going prompts, sent in turn; none mentions time, spend or that a minimum exists. */
export const CUSTOM_CONTINUATION_PROMPTS = [
  "Go back over your work from the start and check it against the original request. Fix anything that's wrong or missing.",
  "Investigate further. Look more closely at the parts you went through quickly, and go deeper where it would improve the result.",
  "Check your assumptions. Is there anything you took for granted but didn't verify? Verify it now.",
  "Try the result the way the person who asked would use it, and fix whatever doesn't hold up.",
  "Look for what could go wrong: edge cases, errors, anything misleading. Deal with what you find.",
  "Re-read what you produced with fresh eyes, and correct or clarify anything that needs it.",
] as const;

const PROMPT_CLOSING = "Stay within what the user asked, including anything they added since. "
  + "Don't redo checks you've already done. When you've finished this pass, call task_complete with what you did.";

export function customContinuationPrompt(index: number): string {
  return `${CUSTOM_CONTINUATION_PROMPTS[index % CUSTOM_CONTINUATION_PROMPTS.length]}\n\n${PROMPT_CLOSING}`;
}

const NANO_AIU_PER_CREDIT = 1_000_000_000;
/** The window of a charge first seen before the run's prompt went out: an earlier prompt's. */
const BEFORE_START = -1;
const COMPLETION_TOOL = "task_complete";
export type CustomAutopilotDecision =
  | { kind: "done" }
  | { kind: "continue"; prompt: string; promptIndex: number }
  | { kind: "error"; error: string };

/** A run can't take minimums: it has ended, was stopped, or isn't an Autopilot run. */
export class CustomAutopilotApplyError extends Error {}

/** One run's time and spend, and any minimums; earlier prompts in the chat never count. */
export class CustomAutopilotRun {
  private readonly receipts = new Set<string>();
  /** Unpriced charges by the window they were first seen in, which their price later counts to. */
  private readonly firstSeen = new Map<string, number>();
  private startedAt?: number;
  /** Minimums count from here: the first prompt, or the last time they were applied. */
  private windowStartedAt?: number;
  private window = 0;
  private windowNanoAiu = 0;
  private replaying = false;
  private passStartedAt?: number;
  private nanoAiu = 0;
  private passNanoAiu = 0;
  private passTools = 0;
  /** Passes in a row that reported no charge; one can be a missed event, two mean no metering. */
  private unbilledPasses = 0;
  private nextPrompt = 0;
  /** Passes in a row that used no tools. */
  private idlePasses = 0;
  continuations = 0;
  cancelled = false;

  constructor(private minimums?: CustomAutopilot) {}

  /** The minimums in force; none means the run ends as plain Autopilot or interactive would. */
  get mode(): CustomAutopilot | undefined {
    return this.minimums;
  }

  /** Marks the run's prompt going out; a resend after a stale session keeps the first time. */
  begin(now = Date.now()): void {
    this.startedAt ??= now;
    this.windowStartedAt ??= now;
    this.startPass(now);
  }

  /** When the run's prompt went out, if it has. */
  get startedAtMs(): number | undefined {
    return this.startedAt;
  }

  /** New minimums counted from now; refused until the prompt has gone out. */
  apply(mode: CustomAutopilot, now = Date.now()): void {
    if (this.startedAt === undefined) {
      throw new CustomAutopilotApplyError("The run is still starting. Try again in a moment.");
    }
    this.minimums = mode;
    this.window++;
    this.windowStartedAt = now;
    this.windowNanoAiu = 0;
    this.unbilledPasses = 0;
  }

  private startPass(now: number): void {
    this.passStartedAt = now;
    this.passNanoAiu = 0;
    this.passTools = 0;
  }

  /** Counts each charge once, and each tool the main agent (not a `child`) runs. */
  observe(event: SessionEvent, child = false): void {
    const begun = this.startedAt !== undefined && !this.replaying;
    if (begun && !child && event.type === "tool.execution_start" && event.data?.toolName !== COMPLETION_TOOL) {
      this.passTools++;
    }
    const data = event.type === "assistant.usage" ? event.data
      : event.type === "tool.execution_complete" ? event.data?.toolUsage : undefined;
    if (!data) return;
    const id = data.accounting?.usageId ?? ("requestId" in data ? data.requestId : data.apiCallId) ?? event.id;
    if (this.receipts.has(id)) return;
    const seenIn = this.firstSeen.get(id) ?? (begun ? this.window : BEFORE_START);
    const charge = data.copilotUsage?.totalNanoAiu;
    // An unpriced copy must not hide a priced one that comes later under the same id.
    if (charge === undefined || !Number.isFinite(charge) || charge < 0) {
      this.firstSeen.set(id, seenIn);
      return;
    }
    this.receipts.add(id);
    this.firstSeen.delete(id);
    if (seenIn === BEFORE_START) return;
    this.nanoAiu += charge;
    if (seenIn !== this.window) return;
    this.windowNanoAiu += charge;
    this.passNanoAiu += charge;
  }

  /** Events held from before the run had its feed count as an earlier prompt's. */
  replayHeld(replay: () => void): void {
    this.replaying = true;
    try {
      replay();
    } finally {
      this.replaying = false;
    }
  }

  /** Judged where the run would end. */
  decide(now = Date.now()): CustomAutopilotDecision {
    if (this.windowStartedAt === undefined) return { kind: "error", error: "Custom Autopilot did not start." };
    if (!this.minimums) return { kind: "done" };
    const { minMinutes, minAiCredits } = this.minimums;
    const timeLeft = minMinutes === undefined ? 0 : this.windowStartedAt + minMinutes * 60_000 - now;
    const needsSpend = minAiCredits !== undefined && this.windowNanoAiu < minAiCredits * NANO_AIU_PER_CREDIT;
    if (timeLeft <= 0 && !needsSpend) return { kind: "done" };
    // Partly reported spend is a safe lower bound; none at all can never reach the minimum.
    if (needsSpend && this.passNanoAiu === 0 && this.unbilledPasses > 0) {
      return { kind: "error", error: "Custom Autopilot stopped: no AI credit use was reported, so the minimum can't be measured." };
    }
    // Like Autopilot's own cap on nudges: an agent that keeps stopping with nothing to do is done.
    if (this.idlePassesNow() >= MAX_IDLE_PASSES) return { kind: "done" };
    return { kind: "continue", prompt: customContinuationPrompt(this.nextPrompt), promptIndex: this.nextPrompt };
  }

  private idlePassesNow(): number {
    return this.passTools === 0 ? this.idlePasses + 1 : 0;
  }

  /** Records the keep-going prompt sent; the next one in turn follows it. */
  noteContinued(promptIndex: number, now = Date.now()): void {
    this.nextPrompt = (promptIndex + 1) % CUSTOM_CONTINUATION_PROMPTS.length;
    this.idlePasses = this.idlePassesNow();
    this.unbilledPasses = this.passNanoAiu === 0 ? this.unbilledPasses + 1 : 0;
    this.continuations++;
    this.startPass(now);
  }

  progress(): CustomAutopilotProgress | undefined {
    if (this.windowStartedAt === undefined) return undefined;
    return { startedAt: new Date(this.windowStartedAt).toISOString(), continuations: this.continuations };
  }

  /** The finished pass and the run so far, for spans and logs. */
  describe(now = Date.now()): Record<string, unknown> {
    return {
      minMinutes: this.minimums?.minMinutes,
      minAiCredits: this.minimums?.minAiCredits,
      elapsedMs: this.windowStartedAt === undefined ? 0 : now - this.windowStartedAt,
      spentCredits: this.windowNanoAiu / NANO_AIU_PER_CREDIT,
      runSpentCredits: this.nanoAiu / NANO_AIU_PER_CREDIT,
      continuations: this.continuations,
      passMs: this.passStartedAt === undefined ? 0 : now - this.passStartedAt,
      passTools: this.passTools,
      idlePasses: this.idlePassesNow(),
    };
  }
}
