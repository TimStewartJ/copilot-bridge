// Settings › Copilot › Accounts: the Copilot accounts this machine has signed in, and which one the
// Bridge runs on. Switching restarts the runtime, so it waits until no chat is running.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchCopilotAccounts, switchCopilotAccount, type CopilotAccount } from "../../api";
import { refreshCopilotQuotaQuery } from "../../hooks/queries/useCopilotQuota";
import { queryKeys } from "../../queryClient";
import { Badge, Button, EmptyHint, Notice, SettingList, SettingRow } from "../../design/primitives";
import { SettingsSection } from "./SettingsSection";

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** "Enterprise · example-org · 4% used" */
export function describeCopilotAccount(account: CopilotAccount): string {
  return [
    account.plan ? capitalize(account.plan) : null,
    account.organizations[0] ?? null,
    account.usedPercent !== null ? `${Math.round(account.usedPercent)}% used` : null,
    account.host.replace(/\/+$/, "") !== "https://github.com" ? account.host.replace(/^https?:\/\//, "") : null,
  ].filter(Boolean).join(" · ");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CopilotAccountsSection() {
  const queryClient = useQueryClient();
  const accounts = useQuery({
    queryKey: queryKeys.copilotAccounts,
    queryFn: ({ signal }) => fetchCopilotAccounts(signal),
    staleTime: 30_000,
  });
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fixedToken = accounts.data?.fixedToken ?? false;

  const switchTo = async (account: CopilotAccount) => {
    setSwitching(account.id);
    setError(null);
    try {
      const result = await switchCopilotAccount(account.id);
      queryClient.setQueryData(queryKeys.copilotAccounts, result);
    } catch (cause) {
      setError(errorText(cause));
      void queryClient.invalidateQueries({ queryKey: queryKeys.copilotAccounts });
    } finally {
      // A failed restart may still have switched, so the quota and models are read again either way.
      void refreshCopilotQuotaQuery(queryClient).catch(() => undefined);
      void queryClient.invalidateQueries({ queryKey: queryKeys.models });
      setSwitching(null);
    }
  };

  return (
    <SettingsSection id="settings-copilot-accounts" title="Accounts">
      {accounts.error && !accounts.data && (
        <Notice tone="danger" title="Accounts could not load"
          action={<Button size="sm" onClick={() => void accounts.refetch()}>Retry</Button>}>
          {errorText(accounts.error)}
        </Notice>
      )}
      {accounts.isLoading && <p role="status" className="text-xs text-text-muted">Loading accounts…</p>}
      {accounts.data && accounts.data.accounts.length === 0 && <EmptyHint>No Copilot accounts are signed in.</EmptyHint>}
      {fixedToken && (
        <Notice tone="warning" className="mb-3" title="Account fixed by BRIDGE_COPILOT_GITHUB_TOKEN">
          Remove it from .env and restart to switch here.
        </Notice>
      )}
      {accounts.data && accounts.data.accounts.length > 0 && (
        <SettingList>
          {accounts.data.accounts.map((account) => (
            <SettingRow
              key={account.id}
              label={account.login}
              hint={describeCopilotAccount(account) || undefined}
              control={account.active
                ? <Badge tone="success">Active</Badge>
                : !fixedToken && (
                  <Button size="sm" disabled={switching !== null} onClick={() => void switchTo(account)}
                    aria-label={`Switch to ${account.login}`}>
                    {switching === account.id ? "Switching…" : "Switch"}
                  </Button>
                )}
            />
          ))}
        </SettingList>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-error">{error}</p>}
    </SettingsSection>
  );
}
