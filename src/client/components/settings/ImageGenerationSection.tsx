import type { AppSettings } from "../../api";
import { SettingsSection } from "./SettingsSection";
import { SettingList, SettingRow, Switch } from "../../design/primitives";
import { useSettingsWriter } from "../../hooks/queries/useSettings";

export function ImageGenerationSection({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: (draft: AppSettings) => void;
}) {
  const { pendingKeys } = useSettingsWriter();
  const enabled = draft.imageGeneration?.enabled !== false;
  // Each committed change evicts every cached session on the server, so a second toggle waits
  // until the first has been saved.
  const saving = pendingKeys.has("imageGeneration");

  return (
    <SettingsSection title="Image generation">
      <SettingList>
        <SettingRow
          label="Let chats generate and edit images"
          htmlFor="settings-image-generation"
          hint="Each image costs AI credits on top of the chat model."
          control={(
            <Switch
              id="settings-image-generation"
              checked={enabled}
              disabled={saving}
              onChange={(event) => setDraft({
                ...draft,
                imageGeneration: event.target.checked ? undefined : { enabled: false },
              })}
            />
          )}
        />
      </SettingList>
    </SettingsSection>
  );
}
