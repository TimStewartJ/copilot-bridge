import type { AppSettings } from "../../api";
import type { DeployGuardSettings } from "../../../shared/deploy-guards.js";
import { useSettingsWriter } from "../../hooks/queries/useSettings";
import { SettingsSection } from "./SettingsSection";
import { DraftTextField } from "./DraftTextField";

function compactGuards(guards: DeployGuardSettings): DeployGuardSettings | undefined {
  const next: DeployGuardSettings = {};
  if (guards.blockedEmailPatterns?.length) next.blockedEmailPatterns = guards.blockedEmailPatterns;
  if (guards.denylistFile) next.denylistFile = guards.denylistFile;
  return Object.keys(next).length > 0 ? next : undefined;
}

export function DeployGuardsSection({ draft, setDraft }: { draft: AppSettings; setDraft: (draft: AppSettings) => void }) {
  const { failedKeys, pendingKeys, error: writeError } = useSettingsWriter();
  const pending = pendingKeys.has("deployGuards");
  const error = failedKeys.has("deployGuards") ? writeError?.message : null;
  const update = (patch: DeployGuardSettings) => {
    setDraft({ ...draft, deployGuards: compactGuards({ ...draft.deployGuards, ...patch }) });
  };

  return (
    <SettingsSection title="Deploy guards" description="staging_deploy refuses commits that match these.">
      <div className="space-y-3">
        <DraftTextField
          storageKey="deployGuards.blockedEmailPatterns"
          label="Blocked commit emails"
          help="One per line; * matches any text."
          multiline
          rows={3}
          placeholder="*@corp.example.com"
          value={(draft.deployGuards?.blockedEmailPatterns ?? []).join("\n")}
          error={error}
          pending={pending}
          onCommit={(text) => update({
            blockedEmailPatterns: text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
          })}
        />
        <DraftTextField
          storageKey="deployGuards.denylistFile"
          label="Denylist file"
          help="Keep it outside the repo. One term per line."
          placeholder="Absolute path"
          value={draft.deployGuards?.denylistFile ?? ""}
          error={error}
          pending={pending}
          onCommit={(text) => update({ denylistFile: text.trim() })}
        />
      </div>
    </SettingsSection>
  );
}
