import { useId } from "react";
import type { AppSettings } from "../../api";
import {
  DEFAULT_RESPONSE_STYLE_GUIDANCE,
  MAX_RESPONSE_STYLE_GUIDANCE_LENGTH,
  RESPONSE_DETAIL_OPTIONS,
  resolveResponseStyle,
} from "../../../shared/response-style.js";
import { SettingsSection } from "./SettingsSection";
import { DS, cx } from "../../design/tokens";
import { Button, Details, SettingList, SettingRow } from "../../design/primitives";
import { useSettingsWriter } from "../../hooks/queries/useSettings";
import { DraftTextField } from "./DraftTextField";
import { DEFAULT_IDENTITY } from "../../../shared/session-identity.js";
import {
  AUTO_PROMPT_PROFILE_DESCRIPTION,
  DEFAULT_PROMPT_PROFILE_SETTING,
  PROMPT_PROFILES,
  type PromptProfileSetting,
} from "../../../shared/prompt-profiles.js";

const PROFILE_SETTING_OPTIONS: ReadonlyArray<{ value: PromptProfileSetting; label: string; description: string }> = [
  { value: "auto", label: "Automatic", description: AUTO_PROMPT_PROFILE_DESCRIPTION },
  ...PROMPT_PROFILES.map((profile) => ({ value: profile.id, label: profile.label, description: profile.description })),
];



export function SystemPromptSection({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: (d: AppSettings) => void;
}) {
  const id = useId();
  const style = draft.responseStyle ?? resolveResponseStyle();
  const detailDescription = RESPONSE_DETAIL_OPTIONS.find((option) => option.value === style.detail)?.description;
  const isDefaultStyle = style.detail === "adaptive" && style.guidance === DEFAULT_RESPONSE_STYLE_GUIDANCE;
  const customInstructions = draft.customInstructions ?? "";
  const { failedKeys, pendingKeys, error: writeError } = useSettingsWriter();
  const responseStyleError = failedKeys.has("responseStyle") ? writeError?.message : null;

  const commit = (changes: Partial<AppSettings>) => setDraft({ ...structuredClone(draft), ...changes });
  const profileSetting = draft.promptProfile ?? DEFAULT_PROMPT_PROFILE_SETTING;

  return (
    <>
      <SettingsSection
        title="Profiles"
        description="Default for new chats. Existing chats keep theirs."
      >
        <fieldset aria-describedby={`${id}-profile-help`} className="min-w-0">
          <legend className="sr-only">Default profile for new chats</legend>
          <div className="space-y-1">
            {PROFILE_SETTING_OPTIONS.map((option) => (
              <label key={option.value} className="flex min-h-10 cursor-pointer items-start gap-2 py-1 text-[13px] md:min-h-8">
                <input
                  type="radio"
                  name={`${id}-profile`}
                  value={option.value}
                  checked={profileSetting === option.value}
                  onChange={() => commit({ promptProfile: option.value })}
                  className={cx(DS.control.checkbox, "mt-0.5")}
                />
                <span className="min-w-0">
                  <span className="block text-text-primary">{option.label}</span>
                  <span className="block text-xs text-text-secondary">{option.description}</span>
                </span>
              </label>
            ))}
          </div>
          <p id={`${id}-profile-help`} className={cx(DS.field.help, "mt-2")}>
            Tools and permissions are the same in every profile.
          </p>
          {failedKeys.has("promptProfile") && writeError?.message && (
            <p role="alert" className="mt-1 text-xs text-error">{writeError.message}</p>
          )}
        </fieldset>
      </SettingsSection>

      <SettingsSection
        title="Response style"
        description="Applies to new and resumed chats."
        action={(
          <Button size="sm" variant="ghost" disabled={isDefaultStyle} onClick={() => commit({ responseStyle: resolveResponseStyle() })}>
            Reset to default
          </Button>
        )}
      >
        <SettingList>
          <SettingRow
            label="Default detail"
            hint={<span id={`${id}-detail-help`}>{detailDescription}</span>}
            control={(
              <fieldset aria-describedby={`${id}-detail-help`} className="min-w-0">
                <legend className="sr-only">Default detail</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {RESPONSE_DETAIL_OPTIONS.map((option) => (
                    <label key={option.value} className="inline-flex min-h-10 cursor-pointer items-center gap-2 text-[13px] text-text-secondary md:min-h-8">
                      <input
                        type="radio"
                        name={`${id}-detail`}
                        value={option.value}
                        checked={style.detail === option.value}
                        onChange={() => commit({ responseStyle: { ...style, detail: option.value } })}
                        className={DS.control.checkbox}
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          />
        </SettingList>
        <div className="mt-3 space-y-1">
          <Details label="Style guidance" detail={style.guidance === DEFAULT_RESPONSE_STYLE_GUIDANCE || !style.guidance.trim() ? "Default guidance" : "Customized"}>
            <div className="pt-2">
              <DraftTextField
                storageKey="responseStyle.guidance"
                label="Style guidance"
                multiline
                rows={6}
                value={style.guidance}
                maxLength={MAX_RESPONSE_STYLE_GUIDANCE_LENGTH}
                footer={(text) => <span>{text.length.toLocaleString()} / {MAX_RESPONSE_STYLE_GUIDANCE_LENGTH.toLocaleString()}</span>}
                error={responseStyleError}
                pending={pendingKeys.has("responseStyle")}
                onCommit={(guidance) => commit({ responseStyle: { ...style, guidance } })}
              />
            </div>
          </Details>
          <Details label="Response quality (always on)">
            <p className="pt-2 text-xs leading-relaxed text-text-secondary">
              Supported claims, clear uncertainty, independent judgment and honest reports, whatever the style.
            </p>
          </Details>
        </div>
      </SettingsSection>

      <SettingsSection title="Instructions">
        <div className="space-y-1">
          <Details label="Identity" detail={draft.identity?.trim() ? "Custom identity" : "Bridge default"}>
            <div className="pt-2">
              <DraftTextField
                storageKey="identity"
                label="Identity"
                multiline
                value={draft.identity ?? ""}
                placeholder={DEFAULT_IDENTITY}
                error={failedKeys.has("identity") ? writeError?.message : null}
                pending={pendingKeys.has("identity")}
                onCommit={(identity) => commit({ identity })}
              />
            </div>
          </Details>
          <Details label="Custom instructions" detail={customInstructions.trim() ? "Configured" : "None"}>
            <div className="pt-2">
              <DraftTextField
                storageKey="customInstructions"
                label="Custom instructions"
                multiline
                value={customInstructions}
                placeholder="e.g. Prefer TypeScript over JavaScript. Use the terminology from my project."
                error={failedKeys.has("customInstructions") ? writeError?.message : null}
                pending={pendingKeys.has("customInstructions")}
                onCommit={(text) => commit({ customInstructions: text })}
              />
            </div>
          </Details>
        </div>
      </SettingsSection>
    </>
  );
}
