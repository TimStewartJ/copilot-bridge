import type { AppSettings } from "../../api";
import { SettingsSection } from "./SettingsSection";
import { Select, SettingList, SettingRow } from "../../design/primitives";
import { FUSION_CONTEXT_TOKEN_CHOICES } from "../../../shared/experimental-settings.js";

function tokensLabel(tokens: number): string {
  return `${Math.round(tokens / 1000)}K tokens`;
}

/** Opt-in features that may change or go away (`AppSettings.experimental`). */
export function ExperimentalSection({ draft, setDraft }: { draft: AppSettings; setDraft: (draft: AppSettings) => void }) {
  const current = draft.experimental?.fusionContextTokens;
  const choices = current === undefined || FUSION_CONTEXT_TOKEN_CHOICES.includes(current)
    ? FUSION_CONTEXT_TOKEN_CHOICES
    : [...FUSION_CONTEXT_TOKEN_CHOICES, current].sort((a, b) => a - b);
  return (
    <SettingsSection title="Experimental">
      <SettingList>
        <SettingRow
          label="Copilot Fusion context"
          htmlFor="settings-fusion-context"
          hint="Prompt limit for every Fusion step. Larger limits cost more per turn."
          control={(
            <Select
              id="settings-fusion-context"
              value={current === undefined ? "" : String(current)}
              onChange={(event) => {
                const { fusionContextTokens: _previous, ...rest } = draft.experimental ?? {};
                const next = event.target.value ? { ...rest, fusionContextTokens: Number(event.target.value) } : rest;
                setDraft({ ...draft, experimental: Object.keys(next).length > 0 ? next : undefined });
              }}
            >
              <option value="">Runtime default</option>
              {choices.map((tokens) => <option key={tokens} value={String(tokens)}>{tokensLabel(tokens)}</option>)}
            </Select>
          )}
        />
      </SettingList>
    </SettingsSection>
  );
}
