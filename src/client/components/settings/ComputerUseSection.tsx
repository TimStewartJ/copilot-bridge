import { useCallback, useEffect, useState } from "react";
import {
  fetchComputerUseStatus,
  installCuaDriver,
  type AppSettings,
  type ComputerUseEngine,
  type ComputerUseStatus,
} from "../../api";
import { SettingsSection } from "./SettingsSection";
import { DS } from "../../design/tokens";
import { Button, SegmentedControl, SettingList, SettingRow, Switch, TextInput } from "../../design/primitives";
import { useSettingsWriter } from "../../hooks/queries/useSettings";

const INSTALL_POLL_MS = 2_000;

export function ComputerUseSection({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: (draft: AppSettings) => void;
}) {
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => fetchComputerUseStatus()
    .then((value) => {
      setStatus(value);
      setError(null);
      return value;
    })
    .catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
      return null;
    }), []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installing = status?.cua.installing === true;
  useEffect(() => {
    if (!installing) return;
    const timer = setInterval(() => { void refresh(); }, INSTALL_POLL_MS);
    return () => clearInterval(timer);
  }, [installing, refresh]);

  const { pendingKeys } = useSettingsWriter();
  const computerUse = draft.computerUse ?? {};
  const enabled = computerUse.enabled === true;
  // Cua Driver is offered only where the server can install it; elsewhere the plugin is the engine.
  const cuaSupported = status?.cua.supported === true;
  const engine: ComputerUseEngine = cuaSupported ? computerUse.engine ?? "cua" : "github";
  const engineReady = !status ? true : engine === "cua" ? status.cua.installed : status.plugin.available;
  // Each committed change evicts every cached session on the server, so a second change waits
  // until the first has been saved.
  const saving = pendingKeys.has("computerUse");

  const update = (next: NonNullable<AppSettings["computerUse"]>) => {
    const kept = Object.entries(next).filter(([, value]) => value !== undefined);
    setDraft({ ...draft, computerUse: kept.length > 0 ? Object.fromEntries(kept) : undefined });
  };

  const availability = error
    ? `Status check failed: ${error}`
    : !status
    ? "Checking…"
    : engine === "cua"
    ? status.cua.installed
      ? `Cua Driver ${status.cua.version}. Each chat that uses it runs one local process.`
      : `Cua Driver ${status.cua.version} is not installed.`
    : status.plugin.available
    ? `Copilot plugin ${status.plugin.version ?? "(unknown version)"}.`
    : status.plugin.reason ?? "The Computer Use plugin is not installed.";

  const install = () => {
    setError(null);
    void installCuaDriver()
      .then(setStatus)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  return (
    <SettingsSection title="Computer use">
      <SettingList>
        <SettingRow
          label="Let sessions control desktop apps"
          htmlFor="settings-computer-use"
          hint={<span className={!engineReady || error ? "text-warning" : undefined}>{availability}</span>}
          control={(
            <Switch
              id="settings-computer-use"
              checked={enabled}
              disabled={saving || (!enabled && engine === "github" && status?.plugin.available === false)}
              onChange={(event) => update({ ...computerUse, enabled: event.target.checked || undefined })}
            />
          )}
        >
          {/* copy-ok: safety warning */}
          <p className={DS.field.help}>
            Bridge approves tool requests automatically, so a session can click and type in any app here without asking. Use it only on a Bridge that you alone can reach.
          </p>
        </SettingRow>
        {cuaSupported && (
          <SettingRow
            label="Engine"
            labelId="settings-computer-use-engine"
            control={(
              <SegmentedControl<ComputerUseEngine>
                ariaLabel="Engine"
                options={[
                  { value: "cua", label: "Cua Driver" },
                  { value: "github", label: "Copilot plugin" },
                ]}
                value={engine}
                disabled={saving}
                onChange={(value) => update({ ...computerUse, engine: value })}
              />
            )}
          />
        )}
        {cuaSupported && engine === "cua" && status && !status.cua.installed && (
          <SettingRow
            label={`Cua Driver ${status.cua.version}`}
            hint={status.cua.error ? <span className="text-warning">{status.cua.error}</span> : undefined}
            control={(
              <Button variant="primary" size="sm" disabled={installing} onClick={install}>
                {installing ? "Installing…" : "Install"}
              </Button>
            )}
          />
        )}
        {cuaSupported && engine === "cua" && (
          <SettingRow
            label="Away after (minutes)"
            hint="Without input this long, chats may take the foreground."
            htmlFor="settings-computer-use-away"
            control={(
              <TextInput
                id="settings-computer-use-away"
                type="number"
                inputMode="numeric"
                min={1}
                max={120}
                inputSize="sm"
                className="w-20"
                disabled={saving}
                value={computerUse.awayAfterMinutes ?? status?.awayAfterMinutes ?? 3}
                onChange={(event) => {
                  const minutes = Number(event.target.value);
                  if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 120) update({ ...computerUse, awayAfterMinutes: minutes });
                }}
              />
            )}
          />
        )}
      </SettingList>
    </SettingsSection>
  );
}
