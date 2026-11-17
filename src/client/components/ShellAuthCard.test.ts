import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PendingShellAuthRequestView } from "../api";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
  type ReactDomHarness,
} from "../test-react-harness";
import ShellAuthCard from "./ShellAuthCard";

function request(inputKind: PendingShellAuthRequestView["inputKind"]): PendingShellAuthRequestView {
  return {
    requestId: `auth-${inputKind}`,
    program: "git",
    prompt: "Password for 'https://user@git.example.com':",
    inputKind,
    command: "git push origin main",
    cwd: "/home/user/project",
  };
}

function findButton(root: any, text: string): any {
  const button = findAllByTag(root, "BUTTON").find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

describe("ShellAuthCard", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it.each([
    { inputKind: "secret" as const, type: "password" },
    { inputKind: "text" as const, type: "text" },
  ])("sends a $inputKind answer from a $type field and clears it", async ({ inputKind, type }) => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    harness = await createReactDomHarness();
    await harness.render(createElement(ShellAuthCard, { request: request(inputKind), onSubmit }));

    expect(harness.dom.container.textContent).toContain("git push origin main");
    const [input] = findAllByTag(harness.dom.container, "INPUT");
    expect(getReactProps(input)?.type).toBe(type);
    await harness.act(async () => {
      getReactProps(input)?.onChange?.({ target: { value: "example-answer" } });
    });
    await harness.act(async () => {
      getReactProps(findAllByTag(harness!.dom.container, "FORM")[0])?.onSubmit?.({ preventDefault: vi.fn() });
    });
    await waitUntilAct(harness.act, () => onSubmit.mock.calls.length === 1);

    expect(onSubmit).toHaveBeenCalledWith(`auth-${inputKind}`, { action: "accept", value: "example-answer" });
    expect(getReactProps(findAllByTag(harness.dom.container, "INPUT")[0])?.value).toBe("");
  });

  it.each([
    { button: "Yes", payload: { action: "accept", value: "yes" } },
    { button: "No", payload: { action: "cancel" } },
  ])("answers a confirmation with $button", async ({ button, payload }) => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    harness = await createReactDomHarness();
    await harness.render(createElement(ShellAuthCard, { request: request("confirm"), onSubmit }));

    expect(findAllByTag(harness.dom.container, "INPUT")).toHaveLength(0);
    await harness.act(async () => {
      getReactProps(findButton(harness!.dom.container, button))?.onClick?.();
    });
    await waitUntilAct(harness.act, () => onSubmit.mock.calls.length === 1);

    expect(onSubmit).toHaveBeenCalledWith("auth-confirm", payload);
  });
});
