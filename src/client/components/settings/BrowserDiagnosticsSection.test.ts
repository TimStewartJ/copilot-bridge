import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
  type ReactDomHarness,
} from "../../test-react-harness";
import { BrowserDiagnosticsSection } from "./BrowserDiagnosticsSection";

const apiMocks = vi.hoisted(() => ({
  checkAdoBrowserAuthentication: vi.fn(),
  closeHeadedDiagnosticsBrowser: vi.fn(),
  fetchBrowserDiagnostics: vi.fn(),
  launchHeadedDiagnosticsBrowser: vi.fn(),
  probeBrowserContext: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api")>(),
  ...apiMocks,
}));

function diagnostics() {
  return {
    schemaVersion: 2 as const,
    checkedAt: "2026-09-08T16:00:00.000Z",
    windowHours: 24,
    summary: {
      tone: "warning" as const,
      label: "Functional check required",
      detail: "Browser contexts have not been checked.",
    },
    agentBrowserInstalled: true,
    config: {
      sessionName: "copilot-bridge-test",
      executablePathSource: "auto-detect" as const,
      executablePathConfigured: false,
      masterProfileDirectory: "C:\\Bridge\\authenticated",
      masterProfileDirectoryConfigured: true,
      masterProfileDirectoryExists: true,
      headed: true,
    },
    runtime: {
      agentBrowserInstalled: true,
      transport: {
        kind: "cli" as const,
        state: "stopped" as const,
        namespace: "copilot-bridge",
      },
    },
    contexts: {
      public: {
        context: "public" as const,
        state: "stopped" as const,
        activeOperations: 0,
        queueDepth: 0,
        functionalProbe: { state: "not_run" as const },
        disposableProfileRoot: "C:\\Bridge\\browser-public",
        concurrencyLimit: 5,
      },
      authenticated: {
        context: "authenticated" as const,
        state: "ready" as const,
        activeOperations: 0,
        queueDepth: 0,
        functionalProbe: {
          state: "passed" as const,
          checkedAt: "2026-09-08T15:59:00.000Z",
        },
        profilePath: "C:\\Bridge\\authenticated",
        profileExists: true,
        headed: true,
        serviceChecks: [{
          service: "ado" as const,
          state: "verified" as const,
          checkedAt: "2026-09-08T15:59:30.000Z",
        }],
      },
    },
    issues: [],
  };
}

function findButton(root: any, text: string): any {
  const button = findAllByTag(root, "BUTTON")
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

async function clickButton(harness: ReactDomHarness, text: string): Promise<void> {
  const button = findButton(harness.dom.container, text);
  await harness.act(async () => {
    await getReactProps(button)?.onClick?.();
  });
}

beforeEach(() => {
  apiMocks.fetchBrowserDiagnostics.mockReset();
  apiMocks.fetchBrowserDiagnostics.mockResolvedValue(diagnostics());
  apiMocks.probeBrowserContext.mockReset();
  apiMocks.probeBrowserContext.mockResolvedValue({
    ok: true,
    context: "public",
    state: "ready",
  });
  apiMocks.checkAdoBrowserAuthentication.mockReset();
  apiMocks.checkAdoBrowserAuthentication.mockResolvedValue({
    service: "ado",
    state: "verified",
    checkedAt: "2026-09-08T16:00:00.000Z",
    message: "Azure DevOps authentication verified.",
  });
  apiMocks.launchHeadedDiagnosticsBrowser.mockReset();
  apiMocks.closeHeadedDiagnosticsBrowser.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("BrowserDiagnosticsSection", () => {
  it("renders public and authenticated browser contexts", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(BrowserDiagnosticsSection, {
        draft: { mcpServers: {}, browser: { headed: true } },
        setDraft: vi.fn(),
      }));
      await waitUntilAct(harness.act, () =>
        (harness.dom.container.textContent ?? "").includes("Public browser"),
      );

      const text = harness.dom.container.textContent ?? "";
      expect(text).toContain("Public browser");
      expect(text).toContain("Authenticated browser");
      expect(text).toContain("copilot-bridge");
      expect(text).toContain("ADO: verified");
      expect(text).toContain("Run authenticated browser headed");
    } finally {
      await harness.cleanup();
    }
  });

  it("runs public readiness and Azure DevOps authentication checks", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(BrowserDiagnosticsSection, {
        draft: { mcpServers: {} },
        setDraft: vi.fn(),
      }));
      await waitUntilAct(harness.act, () =>
        (harness.dom.container.textContent ?? "").includes("Check public browser"),
      );

      await clickButton(harness, "Check public browser");
      expect(apiMocks.probeBrowserContext).toHaveBeenCalledWith("public");

      await clickButton(harness, "Verify ADO");
      expect(apiMocks.checkAdoBrowserAuthentication).toHaveBeenCalledOnce();
      await waitUntilAct(harness.act, () =>
        (harness.dom.container.textContent ?? "").includes("Azure DevOps authentication verified."),
      );
    } finally {
      await harness.cleanup();
    }
  });
});
