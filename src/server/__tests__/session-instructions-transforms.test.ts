import { describe, expect, it } from "vitest";
import {
  createCodingModeStatementRemover,
  removeCliOutputSurfaceNote,
  removeConciseReplyDirective,
} from "../session-instructions.js";

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

  it("returns content unchanged when the runtime no longer renders the targeted text", () => {
    const content = "Unrelated section text.";
    expect(removeCliOutputSurfaceNote(content)).toBe(content);
    expect(removeConciseReplyDirective(content)).toBe(content);
    expect(createCodingModeStatementRemover("Unrelated")(content)).toBe(content);
  });
});
