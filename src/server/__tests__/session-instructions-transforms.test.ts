import { describe, expect, it } from "vitest";
import {
  applyAdaptiveReplyDirective,
  applyConciseReplyDirective,
  createCodingModeStatementRemover,
  removeCliOutputSurfaceNote,
  removeConciseReplyDirective,
} from "../session-instructions.js";
import { fingerprintPromptConfig } from "../session-prompt-fingerprint.js";

const MODE = "You are an interactive tool that helps users with software engineering tasks.";

describe("system prompt section transforms", () => {
  it("removes the CLI output-surface note and keeps the rest of tool_efficiency", () => {
    const content = "# Tool usage efficiency\n* Batch calls.\n\nYour output appears in a command-line interface.";
    expect(removeCliOutputSurfaceNote(content)).toBe("# Tool usage efficiency\n* Batch calls.");
    expect(removeCliOutputSurfaceNote(content.replace(/\n/g, "\r\n"))).toBe("# Tool usage efficiency\r\n* Batch calls.");
  });

  it("removes only the concise-reply directive from last_instructions", () => {
    const content = "<task_completion>\n* Verify.\n</task_completion>\nRespond concisely to the user, but be thorough in your work.\n";
    expect(removeConciseReplyDirective(content)).toBe("<task_completion>\n* Verify.\n</task_completion>");
  });

  it("replaces the CLI concise-reply directive with style-specific Bridge tail reminders and fingerprints each distinctly", () => {
    const content = "<task_completion>\n* Verify.\n</task_completion>\nRespond concisely to the user, but be thorough in your work.\n";
    const conciseReminder = "Response style is concise (unless the user asked for detail): lead with the answer in short plain sentences, skip unasked side sections, walkthroughs, and repeats of UI cards or task notes, and stop once the request is met.";
    const adaptiveReminder = "Match reply length to the user's question: lead with the answer in short plain sentences, keep narrow questions and follow-ups brief without repeating UI cards or task notes, and expand only when depth is requested or needed.";

    expect(applyConciseReplyDirective(content)).toBe(`<task_completion>\n* Verify.\n</task_completion>\n${conciseReminder}`);
    expect(applyConciseReplyDirective(content.replace(/\n/g, "\r\n"))).toBe(
      `<task_completion>\r\n* Verify.\r\n</task_completion>\n${conciseReminder}`,
    );
    expect(applyConciseReplyDirective("<task_completion>\n* Verify.\n</task_completion>"))
      .toBe(`<task_completion>\n* Verify.\n</task_completion>\n${conciseReminder}`);

    expect(applyAdaptiveReplyDirective(content)).toBe(`<task_completion>\n* Verify.\n</task_completion>\n${adaptiveReminder}`);

    const hashes = [applyConciseReplyDirective, applyAdaptiveReplyDirective, removeConciseReplyDirective]
      .map((action) => fingerprintPromptConfig({ systemMessage: { sections: { last_instructions: { action } } } }).sections);
    expect(new Set(hashes).size).toBe(3);
  });

  it("removes the software-engineering mode statement whether it is its own paragraph or joined to the identity", () => {
    const remove = createCodingModeStatementRemover("Bridge identity.");
    expect(remove(`Bridge identity.\n\n${MODE}\n\n<response_style>`)).toBe("Bridge identity.\n\n<response_style>");
    expect(remove(`Bridge identity. ${MODE}\n\n<response_style>`)).toBe("Bridge identity.\n\n<response_style>");
    expect(remove(`Bridge identity.\r\n\r\n${MODE}\r\n\r\n<response_style>`)).toBe("Bridge identity.\r\n\r\n<response_style>");
  });

  it("never edits a custom identity that contains the mode statement", () => {
    const identity = `Custom identity. ${MODE}`;
    const remove = createCodingModeStatementRemover(identity);
    expect(remove(`${identity}\n\n${MODE}\n\n<response_style>`)).toBe(`${identity}\n\n<response_style>`);
    expect(remove(`${identity}\n\n<response_style>`)).toBe(`${identity}\n\n<response_style>`);
    expect(remove(`Something else\n\n${MODE}`)).toBe(`Something else\n\n${MODE}`);
  });

  it("never edits user style guidance in the tone section", () => {
    const remove = createCodingModeStatementRemover("Bridge identity.");
    const withoutRuntimeStatement = `Bridge identity.\n\n<response_style>\nGuidance: ${MODE}\n</response_style>`;
    expect(remove(withoutRuntimeStatement)).toBe(withoutRuntimeStatement);
    expect(remove(`Bridge identity.\n\n${MODE}\n\n<response_style>\nGuidance: ${MODE}\n</response_style>`))
      .toBe(`Bridge identity.\n\n<response_style>\nGuidance: ${MODE}\n</response_style>`);
  });
});
