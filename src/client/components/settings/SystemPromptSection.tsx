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
import { Details } from "../../design/primitives";

const DEFAULT_IDENTITY_PLACEHOLDER =
  "You are a helpful AI assistant powered by Copilot Bridge. You are an interactive CLI tool that helps users with software engineering tasks, answers questions, and assists with a wide range of topics. You are versatile and conversational — not limited to coding.";

const TEXTAREA_CLASS_NAME = cx(DS.field.input, DS.field.textarea, "resize-y");
const FIELD_LABEL_CLASS_NAME = cx(DS.field.label, "block mb-1.5");

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
  const hasLegacyBlock = customInstructions.includes("<anti_slop_response_quality") || customInstructions.includes("</anti_slop_response_quality");

  return (
    <SettingsSection title="Responses and instructions" description="Saved changes apply to new chats and fresh session resumes. Chats already in progress are not interrupted.">
      <div className="space-y-5">
        <Details label="Identity" detail={draft.identity?.trim() ? "Custom identity" : "Bridge default"}>
          <div className="pt-2">
          <label htmlFor={`${id}-identity`} className={FIELD_LABEL_CLASS_NAME}>Identity</label>
          <p id={`${id}-identity-help`} className="text-xs text-text-secondary mb-2">
            Defines who the agent is. Replaces the default system identity.
          </p>
          <textarea
            id={`${id}-identity`}
            aria-describedby={`${id}-identity-help`}
            value={draft.identity ?? ""}
            onChange={(e) => {
              const next = structuredClone(draft);
              next.identity = e.target.value;
              setDraft(next);
            }}
            placeholder={DEFAULT_IDENTITY_PLACEHOLDER}
            rows={3}
            className={TEXTAREA_CLASS_NAME}
          />
          </div>
        </Details>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-medium text-text-primary">Response style</h3>
              <p className="text-xs text-text-secondary mt-1">Natural and direct by default. Explicit requests for tone, detail, or format take precedence.</p>
            </div>
            <button
              type="button"
              disabled={isDefaultStyle}
              onClick={() => {
                const next = structuredClone(draft);
                next.responseStyle = resolveResponseStyle();
                setDraft(next);
              }}
              className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, DS.focus, "border border-border disabled:opacity-50")}
            >
              Reset to default
            </button>
          </div>

          <fieldset aria-describedby={`${id}-detail-help`}>
            <legend className="text-xs text-text-secondary mb-1">Default detail</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {RESPONSE_DETAIL_OPTIONS.map((option) => (
                <label key={option.value} className="inline-flex min-h-11 items-center gap-2 text-xs text-text-secondary cursor-pointer">
                  <input
                    type="radio"
                    name={`${id}-detail`}
                    value={option.value}
                    checked={style.detail === option.value}
                    onChange={() => {
                      const next = structuredClone(draft);
                      next.responseStyle = { ...style, detail: option.value };
                      setDraft(next);
                    }}
                    className={DS.control.checkbox}
                  />
                  {option.label}
                </label>
              ))}
            </div>
            <p id={`${id}-detail-help`} className="text-xs text-text-secondary">{detailDescription}</p>
          </fieldset>

          <Details label="Style guidance" detail={style.guidance === DEFAULT_RESPONSE_STYLE_GUIDANCE || !style.guidance.trim() ? "Default guidance" : "Customized"}>
          <div className="pt-2">
            <label htmlFor={`${id}-style`} className={FIELD_LABEL_CLASS_NAME}>Style guidance</label>
            <textarea
              id={`${id}-style`}
              aria-describedby={`${id}-style-help`}
              value={style.guidance}
              onChange={(e) => {
                const next = structuredClone(draft);
                next.responseStyle = { ...style, guidance: e.target.value };
                setDraft(next);
              }}
              maxLength={MAX_RESPONSE_STYLE_GUIDANCE_LENGTH}
              rows={6}
              className={TEXTAREA_CLASS_NAME}
            />
            <div className="flex flex-wrap justify-between gap-2 text-xs text-text-secondary mt-1.5">
              <p id={`${id}-style-help`}>Leave blank to use the default guidance. Use Save to apply edits or reset.</p>
              <span>{style.guidance.length.toLocaleString()} / {MAX_RESPONSE_STYLE_GUIDANCE_LENGTH.toLocaleString()}</span>
            </div>
          </div>
          </Details>

          <Details label="Response quality (always on)">
            <div className="pt-2 text-xs leading-relaxed text-text-secondary">
            <p>Bridge always includes guidance for supported claims, clear uncertainty, independent judgment, and honest reporting of research, changes, and tests. Style preferences do not remove these safeguards.</p>
            </div>
          </Details>
        </div>

        <Details label="Custom instructions" detail={customInstructions.trim() ? "Configured" : "None"}>
        <div className="pt-2">
          <label htmlFor={`${id}-custom`} className={FIELD_LABEL_CLASS_NAME}>Custom Instructions</label>
          <p id={`${id}-custom-help`} className="text-xs text-text-secondary mb-2">
            Additional domain context, preferences, or rules. Set presentation preferences in Response Style instead.
          </p>
          <textarea
            id={`${id}-custom`}
            aria-describedby={`${id}-custom-help`}
            value={customInstructions}
            onChange={(e) => {
              const next = structuredClone(draft);
              next.customInstructions = e.target.value;
              setDraft(next);
            }}
            placeholder="e.g. Prefer TypeScript over JavaScript. Use the terminology from my project."
            rows={3}
            className={TEXTAREA_CLASS_NAME}
          />
        </div>
        </Details>
        {hasLegacyBlock && (
          <p role="note" className="text-xs text-text-secondary">An edited or incomplete legacy response-quality block was preserved here. Review it to avoid overlapping response-style guidance.</p>
        )}
      </div>
    </SettingsSection>
  );
}
