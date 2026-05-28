import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry, McpServerStatus } from "../api";
import type { SessionContextEvent, SessionContextResponse, SessionContextSummary, SessionContextTurn } from "../../shared/session-context.js";
import { createReactDomHarness, findAllByTag, getReactProps, waitTick, waitUntilAct, type ReactDomHarness } from "../test-react-harness";
import McpStatusBar from "./McpStatusBar";

const capabilities = {
  contextWindow: "exact",
  modelUsage: "exact",
  compaction: "marker",
  truncation: "unavailable",
} satisfies SessionContextResponse["capabilities"];

function createContext(partial: Partial<SessionContextResponse> = {}): SessionContextResponse {
  return {
    provider: "copilot",
    summary: null,
    turns: [],
    events: [],
    capabilities,
    ...partial,
  };
}

function createSummary(partial: Partial<SessionContextSummary> = {}): SessionContextSummary {
  return {
    sessionId: "session-1",
    provider: "copilot",
    providerSessionId: "provider-session-1",
    updatedAt: "2026-05-27T12:00:00.000Z",
    currentModel: "gpt-test",
    latestBridgeTurnId: null,
    latestSnapshotAt: null,
    contextWindow: null,
    tokensUsed: null,
    tokensRemaining: null,
    usageRatio: null,
    modelUsage: null,
    provenance: null,
    snapshotCount: 0,
    compactionCount: 0,
    truncationCount: 0,
    shutdownCount: 0,
    ...partial,
  };
}

function createTurn(partial: Partial<SessionContextTurn> = {}): SessionContextTurn {
  return {
    sessionId: "session-1",
    bridgeTurnId: "turn-1",
    provider: "copilot",
    providerSessionId: "provider-session-1",
    providerTurnId: "provider-turn-1",
    attribution: "turn",
    startedAt: null,
    endedAt: null,
    latestEventAt: null,
    model: null,
    ...partial,
  };
}

function createEvent(partial: Partial<SessionContextEvent> = {}): SessionContextEvent {
  return {
    id: 1,
    sessionId: "session-1",
    provider: "copilot",
    providerSessionId: "provider-session-1",
    providerEventId: "provider-event-1",
    providerTurnId: "provider-turn-1",
    bridgeTurnId: "turn-1",
    attribution: "turn",
    type: "context_snapshot",
    occurredAt: "2026-05-27T12:00:00.000Z",
    model: null,
    contextWindow: null,
    tokensUsed: null,
    tokensRemaining: null,
    usageRatio: null,
    modelUsage: null,
    provenance: null,
    metadata: null,
    ...partial,
  };
}

function findButtonContaining(root: any, text: string): any {
  const button = findAllByTag(root, "BUTTON").find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`Button not found containing: ${text}`);
  return button;
}

async function clickButton(act: ReactDomHarness["act"], button: any): Promise<void> {
  await act(async () => {
    getReactProps(button)?.onClick?.({
      currentTarget: button,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    await waitTick();
  });
}

describe("McpStatusBar session health", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  async function renderBar(props: Partial<Parameters<typeof McpStatusBar>[0]> = {}) {
    harness = await createReactDomHarness();
    const servers: McpServerStatus[] = props.servers ?? [{ name: "filesystem", status: "connected" }];
    await harness.render(createElement(McpStatusBar, { servers, ...props }));
    return harness;
  }

  it("shows MCP status and context usage in the collapsed bar", async () => {
    const { dom } = await renderBar({
      servers: [
        { name: "filesystem", status: "connected" },
        { name: "github", status: "needs-auth" },
      ],
      context: createContext({
        summary: createSummary({ tokensUsed: 75_000, contextWindow: 100_000, usageRatio: 0.75 }),
      }),
    });

    const text = dom.container.textContent ?? "";
    expect(text).toContain("MCP: 1/2 connected");
    expect(text).toContain("1 needs auth");
    expect(text).toContain("Context: 75% · 75,000/100,000 tokens");
  });

  it("uses an explicit waiting state instead of zero when usage is not reported", async () => {
    const { dom } = await renderBar({
      servers: [],
      contextLoading: true,
    });

    const text = dom.container.textContent ?? "";
    expect(text).toContain("MCP: 0/0 connected");
    expect(text).toContain("Context: waiting for usage");
    expect(text).not.toContain("0 tokens");
  });

  it("expands context graph from chat entries and preserves MCP auth controls", async () => {
    const onAuthenticate = vi.fn().mockResolvedValue({
      serverName: "github",
      authorizationUrl: "https://example.test/login",
      servers: [{ name: "github", status: "needs-auth" }],
    });
    const chatEntries: ChatEntry[] = [
      { id: "user-1", role: "user", turnId: "turn-1", content: "Please inspect the repo and summarize the risk." },
      { id: "assistant-1", role: "assistant", turnId: "turn-1", content: "I will inspect it." },
    ];
    const { dom, act } = await renderBar({
      servers: [{ name: "github", status: "needs-auth" }],
      onAuthenticate,
      onRefresh: vi.fn().mockResolvedValue(undefined),
      chatEntries,
      context: createContext({
        summary: createSummary({
          tokensUsed: 42_000,
          contextWindow: 100_000,
          tokensRemaining: 58_000,
          usageRatio: 0.42,
          modelUsage: { inputTokens: 30_000, outputTokens: 12_000 },
          provenance: {
            tokensUsed: { source: "live", confidence: "exact" },
            contextWindow: { source: "live", confidence: "exact" },
            modelUsage: { source: "live", confidence: "partial" },
          },
        }),
        turns: [createTurn({ bridgeTurnId: "turn-1" })],
        events: [createEvent({
          bridgeTurnId: "turn-1",
          type: "compaction",
          tokensUsed: 4_200,
          contextWindow: 10_000,
          usageRatio: 0.42,
          modelUsage: { inputTokens: 3_000, outputTokens: 1_200 },
          provenance: {
            tokensUsed: { source: "live", confidence: "exact" },
          },
          metadata: { preview: "server preview should not render" },
        })],
      }),
    });

    await clickButton(act, findButtonContaining(dom.container, "MCP:"));

    expect(dom.container.textContent).toContain("MCP servers");
    expect(dom.container.textContent).toContain("Context graph");
    expect(dom.container.textContent).toContain("T1");
    expect(dom.container.textContent).toContain("42%");
    expect(dom.container.textContent).toContain("provider");
    expect(dom.container.textContent).not.toContain("Please inspect the repo and summarize the risk.");
    expect(dom.container.textContent).not.toContain("server preview should not render");
    const graph = findAllByTag(dom.container, "DIV").find((node) => node.getAttribute?.("role") === "img");
    expect(graph?.getAttribute("aria-label")).toContain("Context usage graph");

    await clickButton(act, findButtonContaining(dom.container, "Start sign-in"));
    await waitUntilAct(act, () => dom.container.textContent?.includes("Open sign-in") ?? false);

    expect(onAuthenticate).toHaveBeenCalledWith("github", { forceReauth: false });
    expect(dom.container.textContent).toContain("Open sign-in");
    expect(dom.container.textContent).toContain("Check status");
  });
});
