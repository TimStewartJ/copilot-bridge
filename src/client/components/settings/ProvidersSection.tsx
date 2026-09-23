import { useState } from "react";
import { Check } from "lucide-react";
import type { AppSettings, GitHubProviderConfig, LinearProviderConfig, ProvidersConfig } from "../../api";
import { SettingsSection } from "./SettingsSection";
import { ConfigCard } from "./ConfigCard";
import { ProviderEditor, type ProviderEditorField } from "./ProviderEditor";
import { DS, cx } from "../../design/tokens";
import { SettingList } from "../../design/primitives";

const ADO_FIELDS: ProviderEditorField[] = [
  { key: "org", label: "Organization", placeholder: "e.g. my-org", required: true },
  { key: "project", label: "Project", placeholder: "e.g. MyProject", required: true },
];

const GITHUB_FIELDS: ProviderEditorField[] = [
  { key: "owner", label: "Default owner (optional)", placeholder: "e.g. microsoft" },
  {
    key: "defaultRepo",
    label: "Default repository (optional)",
    placeholder: "e.g. vscode",
    validate: (value, values) =>
      value && !values.owner
        ? "Default owner is required when a default repository is set"
        : null,
  },
];

const LINEAR_FIELDS: ProviderEditorField[] = [
  { key: "workspace", label: "Workspace slug", placeholder: "e.g. my-company", required: true },
  { key: "apiKey", label: "Personal API key", placeholder: "lin_api_...", required: true },
];

export function ProvidersSection({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: (d: AppSettings) => void;
}) {
  const [editingProvider, setEditingProvider] = useState<
    "ado" | "github" | "linear" | null
  >(null);

  const providers = draft.providers ?? {};

  const updateProvider = (updated: ProvidersConfig) => {
    const next = structuredClone(draft);
    const cleaned: ProvidersConfig = {};
    if (updated.ado?.org || updated.ado?.project) cleaned.ado = updated.ado;
    if (updated.github?.owner || updated.github?.defaultRepo)
      cleaned.github = updated.github;
    if (updated.linear?.workspace || updated.linear?.apiKey)
      cleaned.linear = updated.linear;
    next.providers = Object.keys(cleaned).length > 0 ? cleaned : undefined;
    setDraft(next);
    setEditingProvider(null);
  };

  const removeProvider = (label: string, key: "ado" | "github" | "linear") => {
    const confirmed = window.confirm(
      `Remove ${label} provider configuration?\n\nThis can't be undone.`,
    );
    if (!confirmed) return;
    updateProvider({ ...providers, [key]: undefined });
  };

  const stateWord = (text: string, on = false) => (
    <span className={cx("inline-flex items-center gap-1 text-xs", on ? "text-text-secondary" : "text-text-faint")}>
      {on && <Check size={11} aria-hidden="true" />}
      {text}
    </span>
  );
  const configuredBadge = stateWord("configured", true);
  const notConfiguredBadge = stateWord("not configured");
  // GitHub enrichment works without settings, so its badge reports whether
  // defaults for short refs exist rather than whether the provider is usable.
  const githubDefaultsBadge = stateWord("defaults set", true);
  const githubNoDefaultsBadge = stateWord("no defaults");

  return (
    <SettingsSection
      title="Providers"
      description="Used to show linked work items and pull requests."
    >
      <SettingList>
        {/* ADO Provider */}
        {editingProvider === "ado" ? (
          <ProviderEditor
            title="Azure DevOps"
            fields={ADO_FIELDS}
            initialValues={
              providers.ado
                ? { org: providers.ado.org, project: providers.ado.project }
                : undefined
            }
            onSave={(values) =>
              updateProvider({
                ...providers,
                ado: { org: values.org, project: values.project },
              })
            }
            onClear={() => updateProvider({ ...providers, ado: undefined })}
            onCancel={() => setEditingProvider(null)}
            isEditing={!!providers.ado}
          />
        ) : (
          <ConfigCard
            title="Azure DevOps"
            badge={providers.ado ? configuredBadge : notConfiguredBadge}
            onEdit={() => setEditingProvider("ado")}
            onRemove={
              providers.ado
                ? () => removeProvider("Azure DevOps", "ado")
                : undefined
            }
            removeTitle="Remove"
          >
            {providers.ado && (
              <p className={cx(DS.text.literal, "mt-0.5")}>{providers.ado.org} / {providers.ado.project}</p>
            )}
          </ConfigCard>
        )}

        {/* GitHub Provider */}
        {editingProvider === "github" ? (
          <ProviderEditor
            title="GitHub short-reference defaults"
            fields={GITHUB_FIELDS}
            initialValues={
              providers.github
                ? {
                    owner: providers.github.owner,
                    ...(providers.github.defaultRepo
                      ? { defaultRepo: providers.github.defaultRepo }
                      : {}),
                  }
                : undefined
            }
            onSave={(values) => {
              const cfg: GitHubProviderConfig = { owner: values.owner ?? "" };
              if (values.defaultRepo) cfg.defaultRepo = values.defaultRepo;
              updateProvider({ ...providers, github: cfg });
            }}
            onClear={() =>
              updateProvider({ ...providers, github: undefined })
            }
            onCancel={() => setEditingProvider(null)}
            isEditing={!!providers.github}
          />
        ) : (
          <ConfigCard
            title="GitHub"
            badge={providers.github?.owner ? githubDefaultsBadge : githubNoDefaultsBadge}
            onEdit={() => setEditingProvider("github")}
            onRemove={
              providers.github
                ? () => removeProvider("GitHub", "github")
                : undefined
            }
            removeTitle="Remove"
          >
            <p className={cx(DS.setting.hint, "mt-0.5")}>
              <code>owner/repo#123</code> refs and URLs link without configuration; defaults fill in short refs.
            </p>
            {providers.github && (
              <p className={cx(DS.text.literal, "mt-0.5")}>
                {[providers.github.owner, providers.github.defaultRepo].filter(Boolean).join(" / ")}
              </p>
            )}
          </ConfigCard>
        )}

        {/* Linear Provider */}
        {editingProvider === "linear" ? (
          <ProviderEditor
            title="Linear"
            fields={LINEAR_FIELDS}
            initialValues={
              providers.linear
                ? {
                    workspace: providers.linear.workspace,
                    apiKey: providers.linear.apiKey,
                  }
                : undefined
            }
            onSave={(values) => {
              const cfg: LinearProviderConfig = { workspace: values.workspace, apiKey: values.apiKey };
              updateProvider({ ...providers, linear: cfg });
            }}
            onClear={() =>
              updateProvider({ ...providers, linear: undefined })
            }
            onCancel={() => setEditingProvider(null)}
            isEditing={!!providers.linear}
          />
        ) : (
          <ConfigCard
            title="Linear"
            badge={providers.linear ? configuredBadge : notConfiguredBadge}
            onEdit={() => setEditingProvider("linear")}
            onRemove={
              providers.linear
                ? () => removeProvider("Linear", "linear")
                : undefined
            }
            removeTitle="Remove"
          >
            {providers.linear && (
              <p className={cx(DS.text.literal, "mt-0.5")}>
                {providers.linear.workspace} · {providers.linear.apiKey.slice(0, 8)}••••••
              </p>
            )}
          </ConfigCard>
        )}
      </SettingList>
    </SettingsSection>
  );
}
