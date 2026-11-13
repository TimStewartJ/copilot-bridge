import { describe, expect, it } from "vitest";
import type { ToolArgs, ToolCall } from "../api";
import { AUTOMATIC_ANSWERS } from "../../shared/automatic-answer.js";
import { readAskUserRecord } from "./ask-user-record";

function call(args: ToolArgs, result?: string, partial: Partial<ToolCall> = {}): ToolCall {
  return {
    toolCallId: "ask",
    name: "ask_user",
    args,
    ...(result !== undefined ? { result, success: true } : {}),
    ...partial,
  };
}

const FORM = {
  message: "How should failures be counted?",
  requestedSchema: {
    properties: {
      preProv: {
        type: "string",
        title: "Failures before OS provisioning",
        oneOf: [
          { const: "separate", title: "Count them separately" },
          { const: "drop", title: "Leave them out" },
        ],
      },
      regions: { type: "array", title: "Regions", items: { anyOf: [{ const: "n", title: "North, primary" }, { const: "s", title: "South" }] } },
      db: { type: "string", title: "Database", enum: ["pg", "my"], enumNames: ["PostgreSQL", "MySQL"] },
      ready: { type: "boolean", title: "Ready" },
      note: { type: "string", title: "Anything else", description: "Optional." },
    },
    required: ["preProv"],
  },
};

describe("readAskUserRecord", () => {
  // The CLI's wording for an answer differs between releases; every form must reach the user whole.
  it.each([
    [
      "field titles and option labels",
      "User responded:\nFailures before OS provisioning: Count them separately\nRegions: North, primary, South\nAnything else: first line\nsecond line",
      "Failures before OS provisioning: Count them separately\nRegions: North, primary, South\nAnything else: first line\nsecond line",
    ],
    ["field keys and option values", "User responded:\npreProv: separate\nregions: n, s", "preProv: separate\nregions: n, s"],
    ["Windows line breaks", "User responded:\r\nAnything else: first line\r\nsecond line", "Anything else: first line\nsecond line"],
    ["one line", "User responded: preProv=separate, regions=n, s", "preProv=separate, regions=n, s"],
  ])("shows the recorded answer as written: %s", (_name, result, answer) => {
    const record = readAskUserRecord(call(FORM, result));

    expect(record?.outcome).toBe("answered");
    expect(record?.answer).toBe(answer);
  });

  it("reads the offered fields from the question's own arguments", () => {
    expect(readAskUserRecord(call(FORM))?.fields).toEqual([
      { key: "preProv", title: "Failures before OS provisioning", options: ["Count them separately", "Leave them out"] },
      { key: "regions", title: "Regions", options: ["North, primary", "South"] },
      { key: "db", title: "Database", options: ["PostgreSQL", "MySQL"] },
      { key: "ready", title: "Ready", options: [] },
      { key: "note", title: "Anything else", description: "Optional.", options: [] },
    ]);
    expect(readAskUserRecord(call({ question: "Which?", choices: ["A", "B"] }, "User responded: B"))).toEqual({
      message: "Which?",
      fields: [{ key: "", title: "", options: ["A", "B"] }],
      outcome: "answered",
      answer: "B",
    });
  });

  it("names the outcome when there is no answer", () => {
    expect(readAskUserRecord(call(FORM, "User cancelled the request."))?.outcome).toBe("cancelled");
    expect(readAskUserRecord(call(FORM, "User declined to answer."))?.outcome).toBe("declined");
    expect(readAskUserRecord(call(FORM, "The user is not available to respond and will review your work later."))?.outcome)
      .toBe("away");
    expect(readAskUserRecord(call(FORM))?.outcome).toBe("unanswered");
    expect(readAskUserRecord(call(FORM, "boom", { success: false }))).toMatchObject({ outcome: "failed", note: "boom" });
    expect(readAskUserRecord(call(FORM, "Something new"))).toMatchObject({ outcome: "other", note: "Something new" });
  });

  it("does not show a reply Bridge gave in the user's place as the user's answer", () => {
    for (const [reason, outcome] of [["unanswered", "away"], ["autopilot", "autopilot"], ["skipped", "skipped"]] as const) {
      for (const result of [`User responded:\nFailures before OS provisioning: ${AUTOMATIC_ANSWERS[reason]}`, `User responded: ${AUTOMATIC_ANSWERS[reason]}`]) {
        const record = readAskUserRecord(call(FORM, result));
        expect(record?.outcome).toBe(outcome);
        expect(record?.answer).toBeUndefined();
      }
    }
  });

  it("ignores other tools and calls with no question", () => {
    expect(readAskUserRecord(call(FORM, undefined, { name: "powershell" }))).toBeNull();
    expect(readAskUserRecord(call({ requestedSchema: {} }))).toBeNull();
  });
});
