import { describe, expect, it, vi } from "vitest";
import { approveAll, CopilotClient } from "@github/copilot-sdk";

describe("Copilot SDK native session contracts", () => {
  it("forwards Bridge session options to the runtime on create and resume", async () => {
    const client = new CopilotClient();
    const sendRequest = vi.fn(async (method: string, params: { sessionId?: string }) =>
      method === "session.create" || method === "session.resume" ? { sessionId: params.sessionId } : {});
    (client as unknown as { connection: unknown }).connection = { sendRequest };
    const config = {
      onPermissionRequest: approveAll,
      tools: [{ name: "bridge_tool", description: "Bridge tool", parameters: { type: "object" }, defer: true, handler: async () => "ok" }],
      toolSearch: { enabled: false },
      githubMcpToolConfig: { additionalTools: ["web_search"] },
      askUserVariant: "elicitation",
    } as unknown as Parameters<CopilotClient["createSession"]>[0];

    const session = await client.createSession(config);
    await client.resumeSession(session.sessionId, config);

    for (const method of ["session.create", "session.resume"]) {
      const params = sendRequest.mock.calls.find(([name]) => name === method)?.[1];
      expect(params, method).toMatchObject({
        tools: [expect.objectContaining({ name: "bridge_tool", defer: true })],
        toolSearch: { enabled: false },
        githubMcpToolConfig: { additionalTools: ["web_search"] },
        askUserVariant: "elicitation",
      });
    }
  });
});
