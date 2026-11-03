import { describe, expect, it } from "vitest";
import { toCopilotAccounts } from "../copilot-accounts.js";

const user = (login: string, type = "user", extra: Record<string, unknown> = {}) => ({
  selectionId: `sel-${login}-${type}`,
  token: `secret-${login}`,
  authInfo: {
    type,
    host: "https://github.com",
    login,
    copilotUser: { login, copilot_plan: "business", organization_login_list: ["example-org"], ...extra },
  },
});

describe("toCopilotAccounts", () => {
  it("lists held logins once, without tokens or borrowed credentials, and marks the current one", () => {
    const users = [user("first-user"), user("second-user"), user("gh-user", "gh-cli"), user("env-user", "env"), user("first-user", "user")];
    const quota = new Map<string, unknown>([
      ["sel-first-user-user", { quotaSnapshots: { premium_interactions: { remainingPercentage: 96, isUnlimitedEntitlement: false } } }],
      ["sel-second-user-user", { quotaSnapshots: { premium_interactions: { remainingPercentage: 0, isUnlimitedEntitlement: true } } }],
    ]);

    const accounts = toCopilotAccounts(users, { type: "user", host: "https://github.com/", login: "Second-User" }, quota);

    expect(accounts).toEqual([
      { id: "sel-first-user-user", host: "https://github.com", login: "first-user", plan: "business", organizations: ["example-org"], active: false, usedPercent: 4 },
      { id: "sel-second-user-user", host: "https://github.com", login: "second-user", plan: "business", organizations: ["example-org"], active: true, usedPercent: null },
    ]);
    expect(JSON.stringify(accounts)).not.toContain("secret");
  });
});
