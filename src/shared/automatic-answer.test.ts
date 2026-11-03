import { describe, expect, it } from "vitest";
import { AUTOMATIC_ANSWERS, readAutomaticAnswerReason } from "./automatic-answer.js";

describe("automatic answers", () => {
  it("tells the agent the reply is no approval, whatever the reason", () => {
    for (const answer of [AUTOMATIC_ANSWERS.autopilot, AUTOMATIC_ANSWERS.unanswered]) {
      expect(answer).toContain("This automatic reply is not an approval");
      expect(answer).toContain("Work autonomously and make good decisions.");
    }
    expect(AUTOMATIC_ANSWERS.autopilot).toContain("Autopilot is on, so this question was not shown to the user");
    // The user is present and has just spoken, so the agent is sent to their message, not told to go on alone.
    expect(AUTOMATIC_ANSWERS.skipped).toContain("neither an answer to the question nor an approval");
    expect(AUTOMATIC_ANSWERS.skipped).not.toContain("Work autonomously");
  });

  it("reads the reason back from a tool result", () => {
    expect(readAutomaticAnswerReason(`User responded: ${AUTOMATIC_ANSWERS.autopilot}`)).toBe("autopilot");
    expect(readAutomaticAnswerReason(`User responded: ${AUTOMATIC_ANSWERS.unanswered}`)).toBe("unanswered");
    expect(readAutomaticAnswerReason(`User responded:\nchoice: ${AUTOMATIC_ANSWERS.skipped}`)).toBe("skipped");
    // What the Copilot CLI tells the model when the user declines a form.
    expect(readAutomaticAnswerReason(
      "The user is not available to respond and will review your work later. Work autonomously and make good decisions.",
    )).toBe("unanswered");
    expect(readAutomaticAnswerReason("User responded: ship it")).toBeUndefined();
  });
});
