import { useEffect, useState } from "react";
import { fetchComputerUseStatus, type AppSettings, type ComputerUseStatus } from "../../api";
import { SettingsSection } from "./SettingsSection";
import { DS } from "../../design/tokens";
import { SettingList, SettingRow, Switch } from "../../design/primitives";
import { useSettingsWriter } from "../../hooks/queries/useSettings";

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

  const { pendingKeys } = useSettingsWriter();
  const enabled = draft.computerUse?.enabled === true;
  const unavailable = status?.available === false;
  // Each committed change evicts every cached session on the server, so a second toggle waits
  // until the first has been saved.
  const saving = pendingKeys.has("computerUse");
  const availability = error
    ? `Status check failed: ${error}`
    : !status
    ? "Checking the installed Copilot SDK…"
    : status.available
    ? `Plugin ${status.version ?? "(unknown version)"}. Each session with it on runs one more local process.`
    : status.reason ?? "The Computer Use plugin is not installed.";

  return (
    <SettingsSection title="Computer use">
      <SettingList>
        <SettingRow
          label="Let sessions control desktop apps"
          htmlFor="settings-computer-use"
          hint={<span className={unavailable || error ? "text-warning" : undefined}>{availability}</span>}
          control={(
            <Switch
              id="settings-computer-use"
              checked={enabled}
              disabled={(unavailable && !enabled) || saving}
              onChange={(event) => setDraft({
                ...draft,
                computerUse: event.target.checked ? { enabled: true } : undefined,
              })}
            />
          )}
        >
          <p className={DS.field.help}>
            Bridge approves tool requests automatically, so a session can click and type in any app here without asking. Use it only on a Bridge that you alone can reach.
          </p>
        </SettingRow>
      </SettingList>
    </SettingsSection>
  );
}
