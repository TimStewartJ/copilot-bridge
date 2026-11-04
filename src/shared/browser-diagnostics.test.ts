import { describe, expect, it } from "vitest";

import { MIN_AGENT_BROWSER_VERSION, isAgentBrowserOutdated } from "./browser-diagnostics.js";

describe("isAgentBrowserOutdated", () => {
  it("says that 0.9.0 is older than the Bridge works with", () => {
    expect(isAgentBrowserOutdated("0.9.0")).toBe(true);
  });

  it.each([MIN_AGENT_BROWSER_VERSION, "0.100.0", "1.0.0"])("says that %s is not", (version) => {
    expect(isAgentBrowserOutdated(version)).toBe(false);
  });

  it("does not call a version it cannot read outdated", () => {
    expect(isAgentBrowserOutdated("")).toBe(false);
    expect(isAgentBrowserOutdated("latest")).toBe(false);
  });
});
