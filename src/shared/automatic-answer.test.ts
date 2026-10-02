import { describe, expect, it } from "vitest";
import { AUTOMATIC_ANSWERS, readAutomaticAnswerReason } from "./automatic-answer.js";

describe("automatic answers", () => {
  it("tells the agent the reply is no approval, whatever the reason", () => {
    for (const answer of Object.values(AUTOMATIC_ANSWERS)) {
      expect(answer).toContain("This automatic reply is not an approval");
      expect(answer).toContain("Work autonomously and make good decisions.");
    }
    expect(AUTOMATIC_ANSWERS.autopilot).toContain("Autopilot is on, so this question was not shown to the user");
  });

  it("reads the reason back from a tool result", () => {
    expect(readAutomaticAnswerReason(`User responded: ${AUTOMATIC_ANSWERS.autopilot}`)).toBe("autopilot");
    expect(readAutomaticAnswerReason(`User responded: ${AUTOMATIC_ANSWERS.unanswered}`)).toBe("unanswered");
    // What the Copilot CLI tells the model when the user declines a form.
    expect(readAutomaticAnswerReason(
      "The user is not available to respond and will review your work later. Work autonomously and make good decisions.",
    )).toBe("unanswered");
    expect(readAutomaticAnswerReason("User responded: ship it")).toBeUndefined();
  });
});
