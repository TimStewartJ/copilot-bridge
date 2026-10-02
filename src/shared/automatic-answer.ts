/**
 * What an agent is told when Bridge answers its question in the user's place, and how to tell
 * such a reply from the user's own when a finished `ask_user` call is read back.
 */

/** Why Bridge answered: the chat was in Autopilot, or nobody answered in time. */
export type AutomaticAnswerReason = "autopilot" | "unanswered";

const OPENINGS: Readonly<Record<AutomaticAnswerReason, string>> = {
  autopilot: "Autopilot is on, so this question was not shown to the user, who will review your work later.",
  unanswered: "The user is not available to respond and will review your work later.",
};

// The Copilot CLI's autopilot `ask_user` response, minus its autopilot-only task_complete tool and
// plus an explicit refusal to stand in for an approval.
const GUIDANCE =
  "Work autonomously and make good decisions. "
  + "This automatic reply is not an approval: do not perform anything that needs the user's explicit confirmation. "
  + "If the request is genuinely ambiguous or unresolvable, stop and summarize the ambiguity rather than proceeding "
  + "on an unfounded assumption.";

export const AUTOMATIC_ANSWERS: Readonly<Record<AutomaticAnswerReason, string>> = {
  autopilot: `${OPENINGS.autopilot} ${GUIDANCE}`,
  unanswered: `${OPENINGS.unanswered} ${GUIDANCE}`,
};

/**
 * Reads why an `ask_user` call was answered without the user, from its result. The reply reaches
 * the model as an answer ("User responded: ..."), so its opening sentence is all that tells it from
 * something the user typed. The Copilot CLI's own reply to a declined form opens the same way as
 * an unanswered question's.
 */
export function readAutomaticAnswerReason(result: string): AutomaticAnswerReason | undefined {
  if (result.includes(OPENINGS.autopilot)) return "autopilot";
  if (result.includes(OPENINGS.unanswered)) return "unanswered";
  return undefined;
}
