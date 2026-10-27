import type { AppSettings } from "../../api";
import { SettingsSection } from "./SettingsSection";
import { SettingList, SettingRow, Switch } from "../../design/primitives";
import { DEFAULT_IMAGE_CEILINGS_MB } from "../../../shared/image-budget.js";

export function ImageBudgetSection({ draft, setDraft }: { draft: AppSettings; setDraft: (draft: AppSettings) => void }) {
  const enabled = draft.imageBudget?.enabled !== false;
  const limits = Object.entries(draft.imageBudget?.ceilingsMb ?? DEFAULT_IMAGE_CEILINGS_MB)
    .map(([pattern, mb]) => `${pattern} at ${mb} MB`)
    .join(", ");
  return (
    <SettingsSection title="Large image conversations">
      <SettingList>
        <SettingRow
          label="Summarize images before a request gets too large"
          htmlFor="settings-image-budget"
          hint={limits ? `Request limits: ${limits}.` : "No model has a request limit set."}
          control={(
            <Switch
              id="settings-image-budget"
              checked={enabled}
              onChange={(event) => {
                const { enabled: _enabled, ...rest } = draft.imageBudget ?? {};
                const next = event.target.checked ? rest : { ...rest, enabled: false };
                setDraft({ ...draft, imageBudget: Object.keys(next).length > 0 ? next : undefined });
              }}
            />
          )}
        />
      </SettingList>
    </SettingsSection>
  );
}
