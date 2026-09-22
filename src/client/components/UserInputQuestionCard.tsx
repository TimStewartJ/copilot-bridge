import { useCallback, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { PendingUserInputRequestView, UserInputAnswerEndpointPayload } from "../api";
import PromptMarkdown from "./chat/PromptMarkdown";
import { DS, cx } from "../design/tokens";
import { Button, ChoiceButton, EmptyHint, Panel, TextInput } from "../design/primitives";
const CHAT_RAIL_CLASS = DS.layout.readingColumn;

function getUserInputSubmitError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return "Failed to submit response.";
}

interface UserInputQuestionCardProps {
  request: PendingUserInputRequestView;
  onSubmit: (requestId: string, payload: UserInputAnswerEndpointPayload) => Promise<void>;
}

export default function UserInputQuestionCard({ request, onSubmit }: UserInputQuestionCardProps) {
  const [freeform, setFreeform] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const submittingRef = useRef(false);
  const choices = request.choices?.filter((choice) => choice.trim().length > 0) ?? [];
  const controlsDisabled = submitting || submitted;

  const submitResponse = useCallback(async (payload: UserInputAnswerEndpointPayload) => {
    if (submittingRef.current || submitted) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(request.requestId, payload);
      setSubmitted(true);
    } catch (err) {
      submittingRef.current = false;
      setError(getUserInputSubmitError(err));
    } finally {
      setSubmitting(false);
    }
  }, [onSubmit, request.requestId, submitted]);

  const handleChoiceClick = useCallback((choice: string) => {
    if (!choice.trim()) {
      setError("Choice response cannot be blank.");
      return;
    }
    void submitResponse({ answer: choice, wasFreeform: false });
  }, [submitResponse]);

  const handleFreeformSubmit = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const answer = freeform.trim();
    if (!answer) {
      setError("Enter a response before submitting.");
      return;
    }
    void submitResponse({ answer, wasFreeform: true });
  }, [freeform, submitResponse]);

  return (
    <div className={CHAT_RAIL_CLASS}>
      <Panel className="max-w-xl">
        <div className={DS.text.attention}>Question</div>
        <PromptMarkdown content={request.question} trusted />

        {choices.length > 0 && (
          <div className={cx(DS.choice.group, "mt-3")}>
            {choices.map((choice, index) => (
              <ChoiceButton
                key={`${choice}-${index}`}
                onClick={() => handleChoiceClick(choice)}
                disabled={controlsDisabled}
              >
                {choice}
              </ChoiceButton>
            ))}
          </div>
        )}

        {request.allowFreeform && (
          <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={handleFreeformSubmit}>
            <TextInput
              value={freeform}
              onChange={(event) => setFreeform(event.target.value)}
              disabled={controlsDisabled}
              className="min-w-0 flex-1"
              placeholder={choices.length > 0 ? "Or type a response..." : "Type a response..."}
              aria-label="Answer question"
            />
            <Button
              type="submit"
              disabled={controlsDisabled}
              icon={submitting ? <Loader2 size={14} className="animate-spin" /> : undefined}
            >
              {submitting ? "Submitting..." : submitted ? "Submitted" : "Submit"}
            </Button>
          </form>
        )}

        {choices.length === 0 && !request.allowFreeform && (
          <EmptyHint className="mt-3">No response options are available for this question.</EmptyHint>
        )}

        {error && (
          <div className="mt-3 text-xs text-error" role="alert">
            {error}
          </div>
        )}
        {!error && (submitting || submitted) && (
          <div
            className="mt-3 flex items-center gap-2 text-xs text-text-muted"
            role="status"
            aria-live="polite"
          >
            {submitting && <Loader2 size={12} className="animate-spin" />}
            {submitting ? "Submitting response..." : "Response submitted. Waiting for the run to continue..."}
          </div>
        )}
      </Panel>
    </div>
  );
}
