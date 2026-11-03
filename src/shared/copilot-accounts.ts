/** A Copilot account the runtime has signed in. Never carries a token. */
export interface CopilotAccount {
  /** The runtime's opaque selection id; stable across runtime restarts. */
  id: string;
  host: string;
  login: string;
  plan: string | null;
  organizations: string[];
  active: boolean;
  /** Share of the premium allowance used this period, or null when unknown or unlimited. */
  usedPercent: number | null;
}

export interface CopilotAccountsStatus {
  accounts: CopilotAccount[];
  /** BRIDGE_COPILOT_GITHUB_TOKEN pins one account, so switching has no effect. */
  fixedToken: boolean;
}
