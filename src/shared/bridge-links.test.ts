import { describe, expect, it } from "vitest";
import {
  bridgeLinkToAppPath,
  formatBridgeLink,
  isBridgeSchemeLink,
  parseBridgeAppPath,
  parseBridgeLink,
} from "./bridge-links.js";

describe("parseBridgeLink", () => {
  it("parses bridge:// links for sessions, tasks and docs", () => {
    expect(parseBridgeLink("bridge://session/AAAAbbbb")).toEqual({ kind: "session", sessionId: "aaaabbbb" });
    expect(parseBridgeLink("bridge://session/aaaabbbb-1111-4000-8000-000000000001")).toEqual({
      kind: "session",
      sessionId: "aaaabbbb-1111-4000-8000-000000000001",
    });
    expect(parseBridgeLink("bridge://task/task-1")).toEqual({ kind: "task", taskId: "task-1" });
    expect(parseBridgeLink("bridge://task/task-1/overview")).toEqual({ kind: "task", taskId: "task-1", view: "overview" });
    expect(parseBridgeLink("bridge://task/task-1/sessions/aaaabbbb")).toEqual({ kind: "session", sessionId: "aaaabbbb", taskId: "task-1" });
    expect(parseBridgeLink("bridge://doc/bridge/rca-2026-09-17-event-loop-freezes")).toEqual({
      kind: "doc",
      path: "bridge/rca-2026-09-17-event-loop-freezes",
    });
    expect(parseBridgeLink("bridge://helm")).toEqual({ kind: "helm" });
  });

  it("tolerates the forms models tend to produce", () => {
    expect(parseBridgeLink(" bridge:session/aaaabbbb ")).toEqual({ kind: "session", sessionId: "aaaabbbb" });
    expect(parseBridgeLink("BRIDGE://sessions/aaaabbbb?from=helm#top")).toEqual({ kind: "session", sessionId: "aaaabbbb" });
    expect(parseBridgeLink("bridge://docs/notes/My%20Page")).toEqual({ kind: "doc", path: "notes/My Page" });
  });

  it("recognizes in-app routes and absolute links to this Bridge", () => {
    expect(parseBridgeLink("/sessions/aaaabbbb")).toEqual({ kind: "session", sessionId: "aaaabbbb" });
    expect(parseBridgeLink("/tasks/t1/sessions/aaaabbbb?message=1")).toEqual({ kind: "session", sessionId: "aaaabbbb", taskId: "t1" });
    expect(parseBridgeLink("/staging/abc/tasks/t1", { basePath: "/staging/abc" })).toEqual({ kind: "task", taskId: "t1" });
    expect(parseBridgeLink("/tasks/t1", { basePath: "/staging/abc" })).toBeNull();
    expect(parseBridgeLink("http://localhost:3333/docs/tellus/plan", { origin: "http://localhost:3333" })).toEqual({ kind: "doc", path: "tellus/plan" });
    expect(parseBridgeLink("http://localhost:3333/staging/abc/helm", { origin: "http://localhost:3333", basePath: "/staging/abc/" })).toEqual({ kind: "helm" });
  });

  it("leaves everything else alone", () => {
    expect(parseBridgeLink("https://github.com/owner/repo/pull/1", { origin: "http://localhost:3333" })).toBeNull();
    expect(parseBridgeLink("http://localhost:3333/settings", { origin: "http://localhost:3333" })).toBeNull();
    expect(parseBridgeLink("http://evil.example/sessions/aaaabbbb", { origin: "http://localhost:3333" })).toBeNull();
    expect(parseBridgeLink("/sessions/new")).toBeNull();
    expect(parseBridgeLink("//evil.example/sessions/aaaabbbb")).toBeNull();
    expect(parseBridgeLink("bridge://session/../secrets")).toBeNull();
    expect(parseBridgeLink("bridge://session/a b")).toBeNull();
    expect(parseBridgeLink("bridge://unknown/thing")).toBeNull();
    expect(parseBridgeLink("bridge://doc/%E0%A4%A")).toBeNull();
    expect(parseBridgeLink("")).toBeNull();
    expect(parseBridgeLink(undefined)).toBeNull();
    expect(parseBridgeAppPath("/")).toBeNull();
  });
});

describe("formatting", () => {
  it("round-trips targets through links and app paths", () => {
    const targets = [
      { kind: "session", sessionId: "aaaabbbb" },
      { kind: "task", taskId: "task-1" },
      { kind: "task", taskId: "task-1", view: "overview" },
      { kind: "doc", path: "notes/My Page" },
      { kind: "helm" },
    ] as const;
    for (const target of targets) {
      expect(parseBridgeLink(formatBridgeLink(target))).toEqual(target);
      expect(parseBridgeAppPath(bridgeLinkToAppPath(target))).toEqual(target);
    }
    expect(formatBridgeLink({ kind: "doc", path: "notes/My Page" })).toBe("bridge://doc/notes/My%20Page");
    expect(bridgeLinkToAppPath({ kind: "session", sessionId: "aaaabbbb", taskId: "t1" })).toBe("/tasks/t1/sessions/aaaabbbb");
  });

  it("detects the scheme", () => {
    expect(isBridgeSchemeLink("bridge://task/1")).toBe(true);
    expect(isBridgeSchemeLink("https://example.com")).toBe(false);
    expect(isBridgeSchemeLink(null)).toBe(false);
  });
});
