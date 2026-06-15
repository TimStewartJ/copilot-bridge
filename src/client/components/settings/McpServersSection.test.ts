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

function findRemoveButton(root: any): any {
  const button = findAllByTag(root, "BUTTON").find(
    (candidate) => getReactProps(candidate)?.title === "Remove",
  );
  if (!button) throw new Error("Remove button not found");
  return button;
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
    await harness.render(createElement(McpServersSection, { resetSignal: 0 }));
    await waitUntilAct(harness.act, () =>
      (harness!.dom.container.textContent ?? "").includes("example"),
    );
    return { confirmSpy };
  }

  it("deletes an MCP server only after the user confirms", async () => {
    const { confirmSpy } = await renderSection(true);
    const button = findRemoveButton(harness!.dom.container);
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
    const button = findRemoveButton(harness!.dom.container);
    await harness!.act(async () => {
      await getReactProps(button)?.onClick?.({});
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(apiMocks.deleteMcpServer).not.toHaveBeenCalled();
  });
});
