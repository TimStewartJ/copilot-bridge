import type { AppSettings } from "../../api";
import { SettingsSection } from "./SettingsSection";

const DEFAULT_IDENTITY_PLACEHOLDER =
  "You are a helpful AI assistant powered by Copilot Bridge. You are an interactive CLI tool that helps users with software engineering tasks, answers questions, and assists with a wide range of topics. You are versatile and conversational — not limited to coding.";

export function SystemPromptSection({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: (d: AppSettings) => void;
}) {
  return (
    <SettingsSection
      title="System Prompt"
      description="Customize the agent's identity and behavior. Changes apply on next session interaction."
    >
      <div className="bg-bg-elevated border border-border rounded-md p-4 space-y-4">
        {/* Identity */}
        <div>
          <label className="text-xs text-text-faint block mb-1.5">Identity</label>
          <p className="text-xs text-text-muted mb-2">
            Defines who the agent is. Replaces the default system identity.
          </p>
          <textarea
            value={draft.identity ?? ""}
            onChange={(e) => {
              const next = structuredClone(draft);
              next.identity = e.target.value;
              setDraft(next);
            }}
            placeholder={DEFAULT_IDENTITY_PLACEHOLDER}
            rows={3}
            className="w-full px-3 py-2 text-xs bg-bg-surface border border-border rounded-md text-text-primary placeholder:text-text-faint/50 focus:outline-none focus:ring-1 focus:ring-accent resize-y"
          />
        </div>

        {/* Custom Instructions */}
        <div>
          <label className="text-xs text-text-faint block mb-1.5">Custom Instructions</label>
          <p className="text-xs text-text-muted mb-2">
            Additional instructions appended to every session — personality, preferences, domain context, or rules.
          </p>
          <textarea
            value={draft.customInstructions ?? ""}
            onChange={(e) => {
              const next = structuredClone(draft);
              next.customInstructions = e.target.value;
              setDraft(next);
            }}
            placeholder="e.g. Always respond in a friendly tone. Prefer TypeScript over JavaScript. When unsure, ask clarifying questions."
            rows={3}
            className="w-full px-3 py-2 text-xs bg-bg-surface border border-border rounded-md text-text-primary placeholder:text-text-faint/50 focus:outline-none focus:ring-1 focus:ring-accent resize-y"
          />
        </div>
      </div>
    </SettingsSection>
  );
}
