import { useEffect, useState } from "react";
import { fetchComputerUseStatus, type AppSettings, type ComputerUseStatus } from "../../api";
import { SettingsSection } from "./SettingsSection";

export function ComputerUseSection({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: (draft: AppSettings) => void;
}) {
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchComputerUseStatus()
      .then((value) => {
        if (!cancelled) setStatus(value);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enabled = draft.computerUse?.enabled === true;
  const unavailable = status?.available === false;
  const availability = error
    ? `Status check failed: ${error}`
    : !status
    ? "Checking the installed Copilot SDK…"
    : status.available
    ? `Computer Use plugin ${status.version ?? "(unknown version)"} is installed with the Copilot SDK.`
    : status.reason ?? "The Computer Use plugin is not installed.";

  return (
    <SettingsSection
      title="Computer use"
      description="Let sessions read and control desktop apps through the Computer Use server that ships with the Copilot SDK."
    >
      <div className="space-y-3 rounded-md border border-border bg-bg-elevated p-4">
        <label className="flex items-start gap-3 rounded-md border border-border bg-bg-primary px-3 py-2">
          <input
            type="checkbox"
            checked={enabled}
            disabled={unavailable && !enabled}
            onChange={(event) => setDraft({
              ...draft,
              computerUse: event.target.checked ? { enabled: true } : undefined,
            })}
            className="mt-0.5 h-3.5 w-3.5 accent-accent"
          />
          <span className="min-w-0">
            <span className="block text-xs font-medium text-text-secondary">
              Enable computer use in sessions
            </span>
            <span className="mt-0.5 block text-[11px] text-text-faint">
              Applies to new sessions, and to existing sessions from their next message. Each session with it on runs one more local process.
            </span>
          </span>
        </label>

        <p className={`text-xs ${unavailable || error ? "text-warning" : "text-text-muted"}`}>
          {availability}
        </p>
        <p className="text-[11px] text-text-faint">
          The Bridge approves tool requests automatically, so a session can click and type in any app on this machine without asking. Turn this on only for a Bridge you alone can reach.
        </p>
      </div>
    </SettingsSection>
  );
}
