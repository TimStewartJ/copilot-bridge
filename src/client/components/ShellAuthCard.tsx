import { useCallback, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { PendingShellAuthRequestView, ShellAuthResponseEndpointPayload } from "../api";
import { DS, cx } from "../design/tokens";
import { Button, Panel, TextInput } from "../design/primitives";
import { haptic } from "../lib/haptics";

const CHAT_RAIL_CLASS = DS.layout.readingColumn;

interface ShellAuthCardProps {
  request: PendingShellAuthRequestView;
  onSubmit: (requestId: string, payload: ShellAuthResponseEndpointPayload) => Promise<void>;
}

/** A shell command the agent runs is asking for a password, a value, or a yes/no answer. */
export default function ShellAuthCard({ request, onSubmit }: ShellAuthCardProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const submittingRef = useRef(false);
  const controlsDisabled = submitting || submitted;
  const secret = request.inputKind === "secret";

  const submit = useCallback(async (payload: ShellAuthResponseEndpointPayload) => {
    if (submittingRef.current || submitted) return;
    submittingRef.current = true;
    // The answer stays in the field only until it is sent.
    setValue("");
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(request.requestId, payload);
      haptic(payload.action === "accept" ? "success" : "light");
      setSubmitted(true);
    } catch (err) {
      submittingRef.current = false;
      haptic("error");
      setError(err instanceof Error && err.message ? err.message : "Could not send the answer.");
    } finally {
      setSubmitting(false);
    }
  }, [onSubmit, request.requestId, submitted]);

  const handleSubmit = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit({ action: "accept", value });
  }, [submit, value]);

  const cancel = () => void submit({ action: "cancel" });
  const fieldLabel = secret ? "Password" : "Answer";

  return (
    <div className={CHAT_RAIL_CLASS}>
      <Panel className="max-w-xl">
        <div className={DS.text.attention}>{request.program}</div>
        {request.prompt.trim() && (
          <div className={cx(DS.text.content, "mt-1 whitespace-pre-wrap break-words")}>{request.prompt.trim()}</div>
        )}
        {request.command && (
          <div className={cx(DS.text.literal, "mt-2 whitespace-pre-wrap break-all")}>{request.command}</div>
        )}

        {request.inputKind === "confirm" ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={() => void submit({ action: "accept", value: "yes" })} disabled={controlsDisabled}>Yes</Button>
            <Button variant="ghost" onClick={cancel} disabled={controlsDisabled}>No</Button>
          </div>
        ) : (
          <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={handleSubmit} autoComplete="off">
            <TextInput
              type={secret ? "password" : "text"}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={controlsDisabled}
              className="min-w-0 flex-1"
              aria-label={fieldLabel}
              placeholder={fieldLabel}
              autoComplete={secret ? "new-password" : "off"}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
            />
            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={controlsDisabled}
                icon={submitting ? <Loader2 size={14} className="animate-spin" /> : undefined}
              >
                Send
              </Button>
              <Button variant="ghost" onClick={cancel} disabled={controlsDisabled}>Cancel</Button>
            </div>
          </form>
        )}

        {error && <div className="mt-3 text-xs text-error" role="alert">{error}</div>}
        {!error && submitted && (
          <div className="mt-3 text-xs text-text-muted" role="status" aria-live="polite">Sent</div>
        )}
      </Panel>
    </div>
  );
}
