import { describe, expect, it } from "vitest";
import { describeToolCall, describeToolCallBriefly, formatDuration, getToolDurationMs, shortenPath } from "./tool-presentation";

describe("describeToolCall", () => {
  it("lets a shell call speak for itself and keeps the command beside it", () => {
    expect(describeToolCall({
      name: "powershell",
      args: { command: "git --no-pager status --short\ngit log -1", description: "Check the working tree" },
    }, "done")).toEqual({
      verb: "Check the working tree",
      target: "git --no-pager status --short",
      mono: true,
      icon: "terminal",
      selfDescribed: true,
    });
  });

  it("leaves the command out where a call has to fit in one phrase and already says what it is for", () => {
    const described = describeToolCall({
      name: "powershell",
      args: { command: "Start-Sleep -Seconds 12", description: "Wait for the build" },
    }, "running");
    expect(describeToolCallBriefly(described)).toBe("Wait for the build");

    // Without its own description, the command is all there is to say.
    expect(describeToolCallBriefly(describeToolCall({ name: "bash", args: { command: "npm test" } }, "running")))
      .toBe("Running npm test");
    expect(describeToolCallBriefly(describeToolCall({ name: "view", args: { path: "/repo/src/App.tsx" } }, "done")))
      .toBe("Read src/App.tsx");
    // A call about an agent swaps its verb for another tense; the agent's name is still needed.
    expect(describeToolCallBriefly(describeToolCall(
      { name: "read_agent", args: { agent_id: "agent-1", wait: true } },
      "running",
      { agentName: () => "moves-agent" },
    ))).toBe("Waiting on moves-agent");
  });

  it("falls back to a verb in the right tense when a shell call has no description", () => {
    const toolCall = { name: "bash", args: { command: "npm test" } };

    expect(describeToolCall(toolCall, "running")).toMatchObject({ verb: "Running", target: "npm test", mono: true });
    expect(describeToolCall(toolCall, "done")).toMatchObject({ verb: "Ran" });
    expect(describeToolCall(toolCall, "failed")).toMatchObject({ verb: "Ran" });
  });

  it("names the file a read or edit touched, with the line range when there is one", () => {
    expect(describeToolCall({
      name: "view",
      args: { path: "E:\\copilot-bridge\\src\\client\\components\\ChatView.tsx", view_range: [120, -1] },
    }, "done")).toMatchObject({ verb: "Read", target: "components/ChatView.tsx · lines 120–end", icon: "file" });
    expect(describeToolCall({ name: "edit", args: { path: "/repo/src/server/event-bus.ts" } }, "running"))
      .toMatchObject({ verb: "Editing", target: "server/event-bus.ts", icon: "file-pen" });
    expect(describeToolCall({ name: "create", args: { path: "notes.md" } }, "done"))
      .toMatchObject({ verb: "Created", target: "notes.md", icon: "file-plus" });
  });

  it("describes searches, fetches and web searches by what they looked for", () => {
    expect(describeToolCall({ name: "grep", args: { pattern: "useSessionStream", glob: "*.ts" } }, "done"))
      .toMatchObject({ verb: "Searched", target: "useSessionStream", mono: true });
    // A pattern like "*" says nothing without the place it was applied to.
    expect(describeToolCall({ name: "glob", args: { pattern: "*", paths: "E:\\repo\\src\\shared" } }, "done"))
      .toMatchObject({ verb: "Found files", target: "* in src/shared" });
    expect(describeToolCall({ name: "grep", args: { pattern: "TODO", paths: ["src/client", "src/server"] } }, "running"))
      .toMatchObject({ verb: "Searching", target: "TODO in 2 places" });
    // GPT models call the same search `rg`.
    expect(describeToolCall({ name: "rg", args: { pattern: "FoodSystem|Boon", paths: "E:\\repo\\src", output_mode: "content" } }, "done"))
      .toMatchObject({ verb: "Searched", target: "FoodSystem|Boon in repo/src", icon: "search" });
    expect(describeToolCall({ name: "web_fetch", args: { url: "https://www.example.com/docs/streaming/" } }, "done"))
      .toMatchObject({ verb: "Fetched", target: "example.com/docs/streaming", mono: false });
    expect(describeToolCall({ name: "web_search", args: { query: "latest React release" } }, "running"))
      .toMatchObject({ verb: "Searching the web", target: "latest React release" });
  });

  it("uses an agent's name and brief for a delegated task", () => {
    expect(describeToolCall({
      name: "🤖 Explore agent",
      isSubAgent: true,
      args: { description: "Investigate scheduler race", prompt: "long prompt" },
    }, "running")).toEqual({
      verb: "Explore agent",
      target: "Investigate scheduler race",
      mono: false,
      icon: "agent",
    });
  });

  it("uses the name and brief the session's records hold for an agent", () => {
    // A stand-in for a launch above the loaded history carries no arguments of its own.
    expect(describeToolCall({
      name: "🤖 general-purpose",
      isSubAgent: true,
      agent: {
        toolCallId: "call-moves",
        name: "moves-agent",
        description: "Refactor move generation",
        status: "running",
        activeMs: 0,
        toolCount: 0,
        failedToolCount: 0,
      },
    }, "running")).toMatchObject({ verb: "moves-agent", target: "Refactor move generation", icon: "agent" });
  });

  it("names the agent a call is about instead of showing its runtime id", () => {
    const agentId = "1c9d6f0e-8a3b-4f5e-9c1d-2b7a6e4f3d10";
    const context = { agentName: (id: string) => id === agentId ? "moves-agent" : undefined };

    expect(describeToolCall({ name: "read_agent", args: { agent_id: agentId } }, "done", context))
      .toEqual({ verb: "Checked", target: "moves-agent", mono: false, icon: "agent" });
    expect(describeToolCall({ name: "read_agent", args: { agent_id: agentId } }, "running", context))
      .toMatchObject({ verb: "Checking", target: "moves-agent" });
    expect(describeToolCall({ name: "write_agent", args: { agent_id: agentId, message: "Also cover castling." } }, "done", context))
      .toMatchObject({ verb: "Messaged", target: "moves-agent" });
    expect(describeToolCall({ name: "write_agent", args: { agent_id: agentId, message: "Also cover castling." } }, "running", context))
      .toMatchObject({ verb: "Messaging", target: "moves-agent" });
  });

  it("says the main agent is waiting on an agent when it asked to be told once the agent is done", () => {
    const context = { agentName: () => "moves-agent" };
    const waiting = { name: "read_agent", args: { agent_id: "agent-moves", wait: true, timeout: 180 } };

    expect(describeToolCall(waiting, "running", context)).toMatchObject({ verb: "Waiting on", target: "moves-agent" });
    expect(describeToolCall(waiting, "done", context)).toMatchObject({ verb: "Waited on", target: "moves-agent" });
  });

  it("falls back to the start of the id for an agent the session's records do not name", () => {
    expect(describeToolCall({ name: "read_agent", args: { agent_id: "1c9d6f0e-8a3b-4f5e-9c1d-2b7a6e4f3d10" } }, "done"))
      .toEqual({ verb: "Checked agent", target: "1c9d6f0e", mono: true, icon: "agent" });
    // A short id is a name already.
    expect(describeToolCall({ name: "write_agent", args: { agent_id: "explore-docs" } }, "done", { agentName: () => undefined }))
      .toMatchObject({ verb: "Messaged agent", target: "explore-docs", mono: true });
  });

  it("reads a tool family's action off its name", () => {
    expect(describeToolCall({ name: "docs_read", args: { path: "bridge/rca" } }, "done"))
      .toMatchObject({ verb: "Docs read", target: "bridge/rca", icon: "book" });
    // The same Bridge tool reached through MCP carries the server's name in front.
    expect(describeToolCall({ name: "bridge-tools-task_update", args: { taskId: "t-1" } }, "done"))
      .toMatchObject({ verb: "Task update", icon: "tasks" });
    expect(describeToolCall({ name: "management_job_status", args: { jobId: "afd0eed2" } }, "running"))
      .toMatchObject({ verb: "Checking job", target: "afd0eed2", icon: "rocket" });
    expect(describeToolCall({ name: "management_job_wait", args: { jobId: "afd0eed2" } }, "running"))
      .toMatchObject({ verb: "Waiting for preview", target: "afd0eed2", icon: "rocket" });
    expect(describeToolCall({ name: "management_job_wait", args: { jobId: "afd0eed2" } }, "done"))
      .toMatchObject({ verb: "Waited for preview", target: "afd0eed2", icon: "rocket" });
    expect(describeToolCall({ name: "task_update_momentum", args: { taskId: "t-1" } }, "done"))
      .toMatchObject({ verb: "Task update momentum", icon: "tasks" });
    expect(describeToolCall({ name: "computer-use-click", args: { app: "notepad" } }, "done"))
      .toMatchObject({ verb: "Computer click", icon: "pointer" });
  });

  it("humanizes a tool it has never heard of and summarizes its arguments", () => {
    expect(describeToolCall({ name: "github-mcp-server-list_issues", args: { query: "is:open" } }, "done"))
      .toEqual({ verb: "Github mcp server list issues", target: "is:open", mono: false, icon: "tool" });
  });

  it("says nothing extra for a verb that is complete on its own", () => {
    expect(describeToolCall({ name: "list_agents", args: { include_completed: false } }, "done"))
      .toEqual({ verb: "Listed agents", target: undefined, mono: false, icon: "agent" });
  });

  it("bounds a pathological target instead of rendering all of it", () => {
    const presentation = describeToolCall({ name: "bash", args: { command: "x".repeat(5_000) } }, "done");

    expect(presentation.target).toHaveLength(240);
    expect(presentation.target?.endsWith("…")).toBe(true);
  });
});

describe("tool timing helpers", () => {
  it("formats durations compactly across magnitudes", () => {
    expect(formatDuration(0)).toBe("1ms");
    expect(formatDuration(420)).toBe("420ms");
    expect(formatDuration(3_240)).toBe("3.2s");
    expect(formatDuration(42_400)).toBe("42s");
    expect(formatDuration(134_000)).toBe("2m 14s");
    expect(formatDuration(3_840_000)).toBe("1h 04m");
    expect(formatDuration(Number.NaN)).toBe("");
    expect(formatDuration(-5)).toBe("");
  });

  it("counts a running clock in whole seconds", () => {
    expect(formatDuration(7_900, { wholeSeconds: true })).toBe("7s");
    expect(formatDuration(59_999, { wholeSeconds: true })).toBe("59s");
    expect(formatDuration(134_500, { wholeSeconds: true })).toBe("2m 15s");
  });

  it("measures a tool only when both ends are known and ordered", () => {
    expect(getToolDurationMs({ startedAt: "2026-09-20T08:00:00.000Z", completedAt: "2026-09-20T08:00:02.500Z" })).toBe(2_500);
    expect(getToolDurationMs({ startedAt: "2026-09-20T08:00:00.000Z" })).toBeUndefined();
    expect(getToolDurationMs({ startedAt: "2026-09-20T08:00:05.000Z", completedAt: "2026-09-20T08:00:00.000Z" })).toBeUndefined();
  });

  it("shortens Windows and POSIX paths the same way", () => {
    expect(shortenPath("C:\\a\\b\\c\\d.ts")).toBe("c/d.ts");
    expect(shortenPath("/a/b/c/d.ts", 3)).toBe("b/c/d.ts");
    expect(shortenPath("d.ts")).toBe("d.ts");
  });
});
