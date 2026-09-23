import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
  type ReactDomHarness,
} from "../../test-react-harness";

const apiMocks = vi.hoisted(() => ({
  fetchMcpServers: vi.fn(),
  fetchGlobalMcpStatus: vi.fn(),
  deleteMcpServer: vi.fn(),
  createMcpServer: vi.fn(),
  updateMcpServer: vi.fn(),
}));

vi.mock("../../api", () => apiMocks);

const { McpServersSection } = await import("./McpServersSection");

const server = {
  id: "server-1",
  name: "example",
  config: { command: "node", args: ["server.js"] },
  enabledByDefault: false,
  createdAt: "2026-05-20T12:00:00.000Z",
  updatedAt: "2026-05-20T12:00:00.000Z",
};

function findButtonByLabel(root: any, label: string): any {
  const button = findAllByTag(root, "BUTTON").find(
    (candidate) => getReactProps(candidate)?.["aria-label"] === label,
  );
  if (!button) throw new Error(`${label} button not found`);
  return button;
}

/** The actions live in the opened row. */
async function openRowAndFindRemove(target: ReactDomHarness): Promise<any> {
  await target.act(async () => {
    getReactProps(findButtonByLabel(target.dom.container, "example details"))?.onClick?.({});
  });
  return findButtonByLabel(target.dom.container, "Remove");
}

describe("McpServersSection remove confirmation", () => {
  let harness: ReactDomHarness | undefined;

  afterEach(() => {
    harness = undefined;
    vi.clearAllMocks();
  });

  async function renderSection(confirmResult: boolean) {
    apiMocks.fetchMcpServers.mockResolvedValue([server]);
    apiMocks.fetchGlobalMcpStatus.mockResolvedValue([]);
    apiMocks.deleteMcpServer.mockResolvedValue(undefined);
    const confirmSpy = vi.fn(() => confirmResult);
    harness = await createReactDomHarness();
    (globalThis.window as unknown as { confirm: () => boolean }).confirm = confirmSpy;
    await harness.render(createElement(McpServersSection));
    await waitUntilAct(harness.act, () =>
      (harness!.dom.container.textContent ?? "").includes("example"),
    );
    return { confirmSpy };
  }

  it("deletes an MCP server only after the user confirms", async () => {
    const { confirmSpy } = await renderSection(true);
    const button = await openRowAndFindRemove(harness!);
    await harness!.act(async () => {
      await getReactProps(button)?.onClick?.({});
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining('Delete MCP server "example"?'),
    );
    expect(apiMocks.deleteMcpServer).toHaveBeenCalledWith("server-1");
  });

  it("keeps the MCP server when the user cancels the confirmation", async () => {
    const { confirmSpy } = await renderSection(false);
    const button = await openRowAndFindRemove(harness!);
    await harness!.act(async () => {
      await getReactProps(button)?.onClick?.({});
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(apiMocks.deleteMcpServer).not.toHaveBeenCalled();
  });
});
