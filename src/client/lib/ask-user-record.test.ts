import { describe, expect, it } from "vitest";
import type { ToolArgs, ToolCall } from "../api";
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

const ONE_OF = {
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
      note: { type: "string", title: "Anything else", description: "Optional." },
    },
    required: ["preProv"],
  },
};

describe("readAskUserRecord", () => {
  it("marks the chosen option and keeps a multi-line text answer", () => {
    const record = readAskUserRecord(call(ONE_OF, "User responded:\npreProv: separate\nnote: first line\nsecond line"));

    expect(record?.outcome).toBe("answered");
    expect(record?.fields[0]).toMatchObject({
      title: "Failures before OS provisioning",
      kind: "choice",
      required: true,
      answered: true,
      options: [
        { value: "separate", label: "Count them separately", selected: true },
        { value: "drop", label: "Leave them out", selected: false },
      ],
    });
    expect(record?.fields[1]).toMatchObject({ kind: "text", answer: "first line\nsecond line", description: "Optional." });
  });

  it("splits multi-select answers against the options, even when an option contains a comma", () => {
    const record = readAskUserRecord(call({
      message: "Close which?",
      requestedSchema: {
        properties: {
          close: { type: "array", items: { anyOf: [{ const: "1 (CI, 9/17)", title: "One" }, { const: "2", title: "Two" }, { const: "3", title: "Three" }] } },
          fixSkill: { type: "boolean", title: "Fix the skill" },
        },
      },
    }, "User responded:\nclose: 1 (CI, 9/17), 3\nfixSkill: true"));

    expect(record?.fields[0]?.options.map((option) => option.selected)).toEqual([true, false, true]);
    expect(record?.fields[0]?.answer).toBeUndefined();
    expect(record?.fields[1]?.options).toEqual([
      { value: "true", label: "Yes", selected: true },
      { value: "false", label: "No", selected: false },
    ]);
  });

  it("reads the enum form with enumNames and an answer outside the options", () => {
    const record = readAskUserRecord(call({
      message: "Pick",
      requestedSchema: { properties: { db: { type: "string", enum: ["pg", "my"], enumNames: ["PostgreSQL", "MySQL"] } } },
    }, "User responded:\ndb: sqlite please"));

    expect(record?.fields[0]?.options.map((option) => option.label)).toEqual(["PostgreSQL", "MySQL"]);
    expect(record?.fields[0]?.options.some((option) => option.selected)).toBe(false);
    expect(record?.fields[0]?.answer).toBe("sqlite please");
  });

  it("reads the older single-question form", () => {
    expect(readAskUserRecord(call({ question: "Share the error?" }, "User responded: use the ADO agent"))).toEqual({
      message: "Share the error?",
      fields: [],
      outcome: "answered",
      freeformAnswer: "use the ADO agent",
    });
    const withChoices = readAskUserRecord(call({ question: "Which?", choices: ["A", "B"] }, "User responded: B"));
    expect(withChoices?.fields[0]?.options.map((option) => option.selected)).toEqual([false, true]);
  });

  it("names the outcome when there is no answer", () => {
    expect(readAskUserRecord(call(ONE_OF, "User cancelled the request."))?.outcome).toBe("cancelled");
    expect(readAskUserRecord(call(ONE_OF, "User declined to answer."))?.outcome).toBe("declined");
    expect(readAskUserRecord(call(ONE_OF, "The user is not available to respond and will review your work later."))?.outcome)
      .toBe("away");
    expect(readAskUserRecord(call(ONE_OF))?.outcome).toBe("unanswered");
    expect(readAskUserRecord(call(ONE_OF, "boom", { success: false }))).toMatchObject({ outcome: "failed", note: "boom" });
  });

  it("ignores other tools and calls with no question", () => {
    expect(readAskUserRecord(call(ONE_OF, undefined, { name: "powershell" }))).toBeNull();
    expect(readAskUserRecord(call({ requestedSchema: {} }))).toBeNull();
  });
});
