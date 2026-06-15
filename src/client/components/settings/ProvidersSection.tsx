import { useState } from "react";
import { Check } from "lucide-react";
import type { AppSettings, GitHubProviderConfig, LinearProviderConfig, ProvidersConfig } from "../../api";
import { SettingsSection } from "./SettingsSection";
import { ConfigCard } from "./ConfigCard";
import { ProviderEditor, type ProviderEditorField } from "./ProviderEditor";

const ADO_FIELDS: ProviderEditorField[] = [
  { key: "org", label: "Organization", placeholder: "e.g. my-org", required: true },
  { key: "project", label: "Project", placeholder: "e.g. MyProject", required: true },
];

const GITHUB_FIELDS: ProviderEditorField[] = [
  { key: "owner", label: "Owner (org or user)", placeholder: "e.g. microsoft", required: true },
  { key: "defaultRepo", label: "Default repository (optional)", placeholder: "e.g. vscode" },
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

  const configuredBadge = (
    <span className="text-[10px] px-1.5 py-0.5 bg-success/15 text-success rounded-full flex items-center gap-0.5">
      <Check size={10} />
      configured
    </span>
  );

  const notConfiguredBadge = (
    <span className="text-[10px] px-1.5 py-0.5 bg-bg-surface text-text-faint rounded-full">
      not configured
    </span>
  );

  return (
    <SettingsSection
      title="Providers"
      description="Work tracking providers for enriching linked work items and pull requests."
    >
      <div className="space-y-2">
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
              <div className="mt-2 space-y-1">
                {[
                  { label: "org", value: providers.ado.org },
                  { label: "project", value: providers.ado.project },
                ].map((f) => (
                  <div key={f.label} className="text-xs text-text-muted">
                    <span className="text-text-faint">{f.label}:</span>{" "}
                    <code className="text-text-secondary">{f.value}</code>
                  </div>
                ))}
              </div>
            )}
          </ConfigCard>
        )}

        {/* GitHub Provider */}
        {editingProvider === "github" ? (
          <ProviderEditor
            title="GitHub"
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
              const cfg: GitHubProviderConfig = { owner: values.owner };
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
            badge={providers.github ? configuredBadge : notConfiguredBadge}
            onEdit={() => setEditingProvider("github")}
            onRemove={
              providers.github
                ? () => removeProvider("GitHub", "github")
                : undefined
            }
            removeTitle="Remove"
          >
            {providers.github && (
              <div className="mt-2 space-y-1">
                <div className="text-xs text-text-muted">
                  <span className="text-text-faint">owner:</span>{" "}
                  <code className="text-text-secondary">
                    {providers.github.owner}
                  </code>
                </div>
                {providers.github.defaultRepo && (
                  <div className="text-xs text-text-muted">
                    <span className="text-text-faint">default repo:</span>{" "}
                    <code className="text-text-secondary">
                      {providers.github.defaultRepo}
                    </code>
                  </div>
                )}
              </div>
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
              <div className="mt-2 space-y-1">
                <div className="text-xs text-text-muted">
                  <span className="text-text-faint">workspace:</span>{" "}
                  <code className="text-text-secondary">
                    {providers.linear.workspace}
                  </code>
                </div>
                <div className="text-xs text-text-muted">
                  <span className="text-text-faint">api key:</span>{" "}
                  <code className="text-text-secondary">
                    {providers.linear.apiKey.slice(0, 8)}••••••
                  </code>
                </div>
              </div>
            )}
          </ConfigCard>
        )}
      </div>
    </SettingsSection>
  );
}
