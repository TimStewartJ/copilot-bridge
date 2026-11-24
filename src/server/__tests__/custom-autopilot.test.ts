import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@github/copilot-sdk";
import {
  CUSTOM_CONTINUATION_PROMPTS,
  CustomAutopilotApplyError,
  CustomAutopilotRun,
  customContinuationPrompt,
} from "../custom-autopilot.js";
import { MAX_IDLE_PASSES } from "../../shared/send-mode.js";

const MINUTE = 60_000;
const event = (value: unknown) => value as SessionEvent;
const usage = (id: string, nanoAiu: number) => event({
  type: "assistant.usage",
  id: `event-${id}`,
  data: { accounting: { usageId: id }, copilotUsage: { totalNanoAiu: nanoAiu } },
});
const credits = (amount: number) => amount * 1_000_000_000;
const tool = (id: string, toolName = "bash") => event({ type: "tool.execution_start", id, data: { toolName } });

/** Ends a pass that ran `tools` tools at `now`, sends what the run decides, and returns that. */
function pass(run: CustomAutopilotRun, now: number, tools: number) {
  for (let i = 0; i < tools; i++) run.observe(tool(`tool-${now}-${i}`));
  const decision = run.decide(now);
  if (decision.kind !== "continue") throw new Error(`the pass at ${now} ended the run: ${decision.kind}`);
  run.noteContinued(decision.promptIndex, now);
  return decision.promptIndex;
}

describe("CustomAutopilotRun", () => {
  it.each([
    { name: "time not reached", mode: { minMinutes: 30 }, at: 10 * MINUTE, spent: 1, kind: "continue" },
    { name: "time reached", mode: { minMinutes: 30 }, at: 30 * MINUTE, spent: 1, kind: "done" },
    { name: "spend not reached", mode: { minAiCredits: 5 }, at: MINUTE, spent: 4, kind: "continue" },
    { name: "spend reached", mode: { minAiCredits: 5 }, at: MINUTE, spent: 5, kind: "done" },
    { name: "both needed", mode: { minMinutes: 30, minAiCredits: 5 }, at: 40 * MINUTE, spent: 4, kind: "continue" },
    { name: "spend not reported once", mode: { minAiCredits: 5 }, at: MINUTE, spent: 0, kind: "continue" },
  ])("decides $name", ({ mode, at, spent, kind }) => {
    const run = new CustomAutopilotRun({ kind: "custom-autopilot", ...mode });
    run.begin(0);
    if (spent) run.observe(usage("call-1", credits(spent)));
    expect(run.decide(at).kind).toBe(kind);
  });

  it("stops with a reason when two passes in a row report no spend toward a credit minimum", () => {
    const run = new CustomAutopilotRun({ kind: "custom-autopilot", minAiCredits: 5 });
    run.begin(0);
    const first = run.decide(MINUTE);
    if (first.kind !== "continue") throw new Error("the first unbilled pass ended the run");
    run.noteContinued(first.promptIndex, MINUTE);
    expect(run.decide(2 * MINUTE).kind).toBe("error");
  });

  it("counts a charge once however many events repeat it", () => {
    const run = new CustomAutopilotRun({ kind: "custom-autopilot", minAiCredits: 2 });
    run.begin(0);
    run.observe(usage("call-1", credits(1.5)));
    run.observe(event({ ...usage("call-1", credits(1.5)), id: "event-again" }));
    expect(run.decide(MINUTE).kind).toBe("continue");
    run.observe(event({ type: "tool.execution_complete", id: "t", data: { toolUsage: { requestId: "tool-1", copilotUsage: { totalNanoAiu: credits(0.5) } } } }));
    expect(run.decide(MINUTE).kind).toBe("done");
  });

  it("counts a charge whose first report came without a price", () => {
    const run = new CustomAutopilotRun({ kind: "custom-autopilot", minAiCredits: 1 });
    run.begin(0);
    run.observe(event({ type: "assistant.usage", id: "unpriced", data: { accounting: { usageId: "call-1" } } }));
    run.observe(usage("call-1", credits(1)));
    expect(run.decide(MINUTE).kind).toBe("done");
  });

  it("counts a sub-agent's spend but not its tools as the pass's work", () => {
    const run = new CustomAutopilotRun({ kind: "custom-autopilot", minAiCredits: 1 });
    run.begin(0);
    run.observe(tool("child-tool"), true);
    run.observe(usage("child-call", credits(1)), true);
    expect(run.describe()).toMatchObject({ passTools: 0, idlePasses: 1 });
    expect(run.decide(MINUTE).kind).toBe("done");
  });

  it("rotates its prompts while each pass does work, without waiting", () => {
    const run = new CustomAutopilotRun({ kind: "custom-autopilot", minMinutes: 60 });
    run.begin(0);
    const sent = Array.from({ length: CUSTOM_CONTINUATION_PROMPTS.length + 2 }, (_, i) => pass(run, (i + 1) * 10_000, 1));
    expect(sent).toEqual([0, 1, 2, 3, 4, 5, 0, 1]);
    expect(run.continuations).toBe(8);
    expect(run.decide(60 * MINUTE).kind).toBe("done");
  });

  it("ends once the agent stops without a tool five times in a row; a pass with tools starts the count again", () => {
    const run = new CustomAutopilotRun({ kind: "custom-autopilot", minMinutes: 60, minAiCredits: 1_000 });
    run.begin(0);
    run.observe(usage("call-0", credits(1)));
    // task_complete is how every pass ends, not work.
    run.observe(tool("done", "task_complete"));
    for (let i = 1; i < MAX_IDLE_PASSES; i++) {
      run.observe(usage(`call-${i}`, credits(1)));
      pass(run, i * MINUTE, 0);
    }
    pass(run, 10 * MINUTE, 1);
    for (let i = 1; i < MAX_IDLE_PASSES; i++) {
      run.observe(usage(`again-${i}`, credits(1)));
      pass(run, (10 + i) * MINUTE, 0);
    }
    run.observe(usage("last", credits(1)));
    expect(run.decide(20 * MINUTE).kind).toBe("done");
  });

  it("never tells the agent about the minimum, its time or its spend", () => {
    for (const prompt of CUSTOM_CONTINUATION_PROMPTS.map((_, i) => customContinuationPrompt(i))) {
      expect(prompt).not.toMatch(/minimum|minute|hour|credit|budget|spend|time left|deadline|\d/i);
    }
  });

  it("counts minimums applied mid-run from then, without counting a charge seen before again", () => {
    const run = new CustomAutopilotRun();
    run.begin(0);
    run.observe(usage("before", credits(3)));
    expect(run.decide(MINUTE).kind).toBe("done");
    run.apply({ kind: "custom-autopilot", minMinutes: 30, minAiCredits: 2 }, 10 * MINUTE);
    expect(run.progress()?.startedAt).toBe(new Date(10 * MINUTE).toISOString());
    run.observe(event({ ...usage("before", credits(3)), id: "event-repeat" }));
    run.observe(usage("after", credits(2)));
    expect(run.decide(39 * MINUTE).kind).toBe("continue");
    expect(run.decide(40 * MINUTE).kind).toBe("done");
  });

  it("counts a charge first seen unpriced before minimums were applied to the window it was seen in", () => {
    const run = new CustomAutopilotRun();
    run.begin(0);
    run.observe(usage("call", Number.NaN));
    run.apply({ kind: "custom-autopilot", minAiCredits: 2 }, MINUTE);
    run.observe(usage("call", credits(5)));
    expect(run.decide(2 * MINUTE).kind).toBe("continue");
  });

  it("counts held events replayed into a run as an earlier prompt's, even repeated later", () => {
    const run = new CustomAutopilotRun({ kind: "custom-autopilot", minAiCredits: 2 });
    run.begin(0);
    run.replayHeld(() => run.observe(usage("held", credits(5))));
    run.observe(event({ ...usage("held", credits(5)), id: "event-repeat" }));
    expect(run.decide(MINUTE).kind).toBe("continue");
  });

  it("restarts the window when the same minimums are applied again", () => {
    const run = new CustomAutopilotRun({ kind: "custom-autopilot", minMinutes: 30 });
    run.begin(0);
    run.apply({ kind: "custom-autopilot", minMinutes: 30 }, 25 * MINUTE);
    expect(run.decide(30 * MINUTE).kind).toBe("continue");
    expect(run.decide(55 * MINUTE).kind).toBe("done");
  });

  it("refuses minimums until the prompt has gone out", () => {
    const run = new CustomAutopilotRun();
    expect(() => run.apply({ kind: "custom-autopilot", minMinutes: 30 }, 0)).toThrow(CustomAutopilotApplyError);
    expect(run.mode).toBeUndefined();
  });

  it("does not let a late price from before minimums were applied count as metered spend", () => {
    const run = new CustomAutopilotRun();
    run.begin(0);
    run.observe(usage("old", Number.NaN));
    run.apply({ kind: "custom-autopilot", minAiCredits: 2 }, 0);
    const first = run.decide(MINUTE);
    if (first.kind !== "continue") throw new Error("the first pass ended the run");
    run.noteContinued(first.promptIndex, MINUTE);
    run.observe(usage("old", credits(1)));
    expect(run.decide(2 * MINUTE).kind).toBe("error");
  });

  it("keeps the first send's time when the prompt is sent again after a stale session", () => {
    const run = new CustomAutopilotRun({ kind: "custom-autopilot", minMinutes: 30 });
    run.begin(0);
    run.begin(5 * MINUTE);
    expect(run.continuations).toBe(0);
    expect(run.decide(30 * MINUTE).kind).toBe("done");
  });
});
