import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingElicitationRequestView } from "../api";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
  type ReactDomHarness,
} from "../test-react-harness";
import ElicitationCard from "./ElicitationCard";

const apiMocks = vi.hoisted(() => ({
  requestBrowserLiveTicket: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api")>(),
  ...apiMocks,
}));

function hasButton(root: any, text: string): boolean {
  return findAllByTag(root, "BUTTON").some((candidate) => candidate.textContent?.trim() === text);
}

function findDialog(root: any): any {
  return findAllByTag(root, "DIV").find((candidate) => getReactProps(candidate)?.role === "dialog");
}

function handoffRequest(): PendingElicitationRequestView {
  return {
    requestId: "el-handoff",
    message: "The agent needs you to act in its browser: Solve the check on the sign-in page.",
    mode: "form",
    browserHandoff: {
      browserSessionId: "bs_ab12cd34",
      reason: "Solve the check on the sign-in page.",
    },
    requestedSchema: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          title: "How did it go?",
          enum: ["done", "not_done"],
          enumNames: ["Done, continue", "I couldn't do it"],
        },
      },
      required: ["outcome"],
    },
  };
}

function findButton(root: any, text: string): any {
  const button = findAllByTag(root, "BUTTON").find((candidate) => (
    candidate.textContent?.trim() === text
  ));
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function findField(root: any, label: string): any {
  const field = [...findAllByTag(root, "INPUT"), ...findAllByTag(root, "TEXTAREA")]
    .find((candidate) => getReactProps(candidate)?.["aria-label"] === label);
  if (!field) throw new Error(`Field not found: ${label}`);
  return field;
}

describe("ElicitationCard", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness?.cleanup();
    harness = null;
  });

  it("renders native form fields and submits defaults plus user values once", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const request: PendingElicitationRequestView = {
      requestId: "el-form",
      message: "Configure deployment",
      mode: "form",
      elicitationSource: "deployment-mcp",
      requestedSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            title: "Target",
            enum: ["staging", "production"],
            default: "staging",
          },
          reason: {
            type: "string",
            title: "Reason",
            minLength: 3,
          },
          retries: {
            type: "integer",
            title: "Retries",
            minimum: 0,
            maximum: 5,
            default: 2,
          },
          notify: {
            type: "boolean",
            title: "Notify",
            default: true,
          },
          checks: {
            type: "array",
            title: "Checks",
            items: {
              anyOf: [
                { const: "unit", title: "Unit tests" },
                { const: "integration", title: "Integration tests" },
              ],
            },
            default: ["unit"],
          },
        },
        required: ["target", "reason"],
      },
    };

    harness = await createReactDomHarness();
    await harness.render(createElement(ElicitationCard, { request, onSubmit }));

    expect(harness.dom.container.textContent).toContain("Requested by deployment-mcp");
    expect(harness.dom.container.textContent).toContain("Do not enter passwords");

    await harness.act(async () => {
      getReactProps(findButton(harness!.dom.container, "production"))?.onClick?.();
      getReactProps(findField(harness!.dom.container, "Reason"))?.onChange?.({
        target: { value: "Release verification" },
      });
      getReactProps(findButton(harness!.dom.container, "Integration tests"))?.onClick?.();
    });
    const form = findAllByTag(harness.dom.container, "FORM")[0];
    await harness.act(async () => {
      getReactProps(form)?.onSubmit?.({ preventDefault: vi.fn() });
    });
    await waitUntilAct(harness.act, () => onSubmit.mock.calls.length === 1);

    expect(onSubmit).toHaveBeenCalledWith("el-form", {
      action: "accept",
      content: {
        target: "production",
        reason: "Release verification",
        retries: 2,
        notify: true,
        checks: ["unit", "integration"],
      },
    });
  });

  it("shows validation errors without submitting incomplete required fields", async () => {
    const onSubmit = vi.fn();
    const request: PendingElicitationRequestView = {
      requestId: "el-required",
      message: "Provide a reason",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            title: "Reason",
            minLength: 3,
          },
        },
        required: ["reason"],
      },
    };

    harness = await createReactDomHarness();
    await harness.render(createElement(ElicitationCard, { request, onSubmit }));
    const form = findAllByTag(harness.dom.container, "FORM")[0];
    await harness.act(async () => {
      getReactProps(form)?.onSubmit?.({ preventDefault: vi.fn() });
    });

    expect(harness.dom.container.textContent).toContain("Reason is required.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("allows omitted optional arrays, preserves required empty arrays, and validates RFC3339 dates", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const request: PendingElicitationRequestView = {
      requestId: "el-edge-fields",
      message: "Configure optional fields",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: {
          optionalChecks: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              enum: ["unit", "integration"],
            },
          },
          requiredChecks: {
            type: "array",
            items: {
              type: "string",
              enum: ["unit", "integration"],
            },
          },
          runAt: {
            type: "string",
            title: "Run at",
            format: "date-time",
          },
          notes: {
            type: "string",
            title: "Notes",
          },
        },
        required: ["requiredChecks", "runAt", "notes"],
      },
    };

    harness = await createReactDomHarness();
    await harness.render(createElement(ElicitationCard, { request, onSubmit }));
    const form = findAllByTag(harness.dom.container, "FORM")[0];

    await harness.act(async () => {
      getReactProps(findField(harness!.dom.container, "Run at"))?.onChange?.({
        target: { value: "2026-07-13T14:30" },
      });
      getReactProps(findField(harness!.dom.container, "Notes"))?.onChange?.({
        target: { value: "  preserve spacing  " },
      });
    });
    await harness.act(async () => {
      getReactProps(form)?.onSubmit?.({ preventDefault: vi.fn() });
    });
    expect(harness.dom.container.textContent).toContain("valid date and time");
    expect(onSubmit).not.toHaveBeenCalled();

    await harness.act(async () => {
      getReactProps(findField(harness!.dom.container, "Run at"))?.onChange?.({
        target: { value: "2026-07-13T14:30:00Z" },
      });
    });
    await harness.act(async () => {
      getReactProps(form)?.onSubmit?.({ preventDefault: vi.fn() });
    });
    await waitUntilAct(harness.act, () => onSubmit.mock.calls.length === 1);

    expect(onSubmit).toHaveBeenCalledWith("el-edge-fields", {
      action: "accept",
      content: {
        requiredChecks: [],
        runAt: "2026-07-13T14:30:00Z",
        notes: "  preserve spacing  ",
      },
    });
  });

  it("submits decline without form content", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const request: PendingElicitationRequestView = {
      requestId: "el-decline",
      message: "Optional preference",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: {
          preference: { type: "string" },
        },
      },
    };

    harness = await createReactDomHarness();
    await harness.render(createElement(ElicitationCard, { request, onSubmit }));
    await harness.act(async () => {
      getReactProps(findButton(harness!.dom.container, "Decline"))?.onClick?.();
    });
    await waitUntilAct(harness.act, () => onSubmit.mock.calls.length === 1);

    expect(onSubmit).toHaveBeenCalledWith("el-decline", { action: "decline" });
  });

  it("explains when a response arrives after the question closed", async () => {
    const onSubmit = vi.fn().mockRejectedValue(
      Object.assign(new Error("Pending elicitation request not found"), { status: 404 }),
    );
    const request: PendingElicitationRequestView = {
      requestId: "el-stale",
      message: "Choose a target",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: {},
      },
    };

    harness = await createReactDomHarness();
    await harness.render(createElement(ElicitationCard, { request, onSubmit }));
    await harness.act(async () => {
      getReactProps(findButton(harness!.dom.container, "Decline"))?.onClick?.();
    });
    await waitUntilAct(
      harness.act,
      () => harness!.dom.container.textContent?.includes("This question is no longer active") ?? false,
    );

    expect(harness.dom.container.textContent).toContain(
      "The run may have ended before your response was accepted.",
    );
  });

  describe("browser handoff", () => {
    beforeEach(() => {
      apiMocks.requestBrowserLiveTicket.mockReset();
    });

    it("shows the agent's reason and answers done through the form's one field", async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      harness = await createReactDomHarness();
      await harness.render(createElement(ElicitationCard, { request: handoffRequest(), onSubmit }));

      const text = harness.dom.container.textContent ?? "";
      expect(text).toContain("Browser needs you");
      expect(text).toContain("Solve the check on the sign-in page.");
      expect(hasButton(harness.dom.container, "Open browser")).toBe(true);
      expect(hasButton(harness.dom.container, "Submit answers")).toBe(false);
      expect(findAllByTag(harness.dom.container, "FORM")).toHaveLength(0);

      await harness.act(async () => {
        getReactProps(findButton(harness!.dom.container, "Done, continue"))?.onClick?.();
      });
      await waitUntilAct(harness.act, () => onSubmit.mock.calls.length === 1);

      expect(onSubmit).toHaveBeenCalledWith("el-handoff", { action: "accept", content: { outcome: "done" } });
      await waitUntilAct(
        harness.act,
        () => harness!.dom.container.textContent?.includes("Response submitted") ?? false,
      );
      for (const label of ["Open browser", "Done, continue", "I couldn't do it"]) {
        expect(getReactProps(findButton(harness.dom.container, label))?.disabled).toBe(true);
      }
    });

    it("answers not done, and shows a failed answer on the card", async () => {
      const onSubmit = vi.fn()
        .mockRejectedValueOnce(new Error("The run is busy."))
        .mockResolvedValue(undefined);
      harness = await createReactDomHarness();
      await harness.render(createElement(ElicitationCard, { request: handoffRequest(), onSubmit }));

      await harness.act(async () => {
        getReactProps(findButton(harness!.dom.container, "I couldn't do it"))?.onClick?.();
      });
      await waitUntilAct(
        harness.act,
        () => harness!.dom.container.textContent?.includes("The run is busy.") ?? false,
      );
      expect(onSubmit).toHaveBeenCalledWith("el-handoff", { action: "accept", content: { outcome: "not_done" } });
      expect(getReactProps(findButton(harness.dom.container, "I couldn't do it"))?.disabled).toBe(false);

      await harness.act(async () => {
        getReactProps(findButton(harness!.dom.container, "I couldn't do it"))?.onClick?.();
      });
      await waitUntilAct(harness.act, () => onSubmit.mock.calls.length === 2);
    });

    it("opens the live browser for the session, and Close leaves the request pending", async () => {
      apiMocks.requestBrowserLiveTicket.mockReturnValue(new Promise(() => {}));
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      harness = await createReactDomHarness();
      await harness.render(createElement(ElicitationCard, { request: handoffRequest(), onSubmit }));
      expect(findDialog(harness.dom.container)).toBeUndefined();

      await harness.act(async () => {
        getReactProps(findButton(harness!.dom.container, "Open browser"))?.onClick?.();
      });
      const dialog = findDialog(harness.dom.container);
      expect(dialog).toBeDefined();
      expect(getReactProps(dialog)?.["aria-modal"]).toBe(true);
      expect(dialog.textContent).toContain("Solve the check on the sign-in page.");
      expect(apiMocks.requestBrowserLiveTicket).toHaveBeenCalledWith("bs_ab12cd34");

      await harness.act(async () => {
        getReactProps(findButton(dialog, "Close"))?.onClick?.();
      });
      expect(findDialog(harness.dom.container)).toBeUndefined();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(getReactProps(findButton(harness.dom.container, "Done, continue"))?.disabled).toBe(false);
    });

    it("keeps what happens in the live browser away from the page that opened it", async () => {
      apiMocks.requestBrowserLiveTicket.mockReturnValue(new Promise(() => {}));
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      harness = await createReactDomHarness();
      await harness.render(createElement(ElicitationCard, { request: handoffRequest(), onSubmit }));
      await harness.act(async () => {
        getReactProps(findButton(harness!.dom.container, "Open browser"))?.onClick?.();
      });

      // A chat reads a wheel turn or a touch inside its transcript as the reader scrolling away.
      const overlay = getReactProps(findDialog(harness.dom.container).parentNode)!;
      for (const handler of ["onWheel", "onTouchStart", "onTouchMove", "onPointerDown", "onMouseDown", "onClick", "onKeyUp"]) {
        const event = { stopPropagation: vi.fn() };
        overlay[handler](event);
        expect(event.stopPropagation, handler).toHaveBeenCalled();
      }

      const escape = {
        key: "Escape",
        defaultPrevented: false,
        nativeEvent: { isComposing: false },
        stopPropagation: vi.fn(),
        preventDefault: vi.fn(),
      };
      await harness.act(async () => {
        overlay.onKeyDown(escape);
      });
      expect(escape.stopPropagation).toHaveBeenCalled();
      expect(findDialog(harness.dom.container)).toBeUndefined();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("answers from inside the live browser and closes it", async () => {
      apiMocks.requestBrowserLiveTicket.mockReturnValue(new Promise(() => {}));
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      harness = await createReactDomHarness();
      await harness.render(createElement(ElicitationCard, { request: handoffRequest(), onSubmit }));

      await harness.act(async () => {
        getReactProps(findButton(harness!.dom.container, "Open browser"))?.onClick?.();
      });
      await harness.act(async () => {
        getReactProps(findButton(findDialog(harness!.dom.container), "I couldn't do it"))?.onClick?.();
      });
      await waitUntilAct(harness.act, () => onSubmit.mock.calls.length === 1);

      expect(onSubmit).toHaveBeenCalledWith("el-handoff", { action: "accept", content: { outcome: "not_done" } });
      expect(findDialog(harness.dom.container)).toBeUndefined();
    });

    it("shows the server's reason when the live browser cannot be opened, and tries again on request", async () => {
      apiMocks.requestBrowserLiveTicket.mockRejectedValue(
        Object.assign(new Error("This browser session has ended."), { status: 404 }),
      );
      harness = await createReactDomHarness();
      await harness.render(createElement(ElicitationCard, { request: handoffRequest(), onSubmit: vi.fn() }));

      await harness.act(async () => {
        getReactProps(findButton(harness!.dom.container, "Open browser"))?.onClick?.();
      });
      await waitUntilAct(
        harness.act,
        () => findDialog(harness!.dom.container)?.textContent?.includes("This browser session has ended.") ?? false,
      );
      expect(apiMocks.requestBrowserLiveTicket).toHaveBeenCalledTimes(1);

      await harness.act(async () => {
        getReactProps(findButton(findDialog(harness!.dom.container), "Try again"))?.onClick?.();
      });
      await waitUntilAct(harness.act, () => apiMocks.requestBrowserLiveTicket.mock.calls.length === 2);
    });

    it("leaves a form with the same field alone when it is not a handoff", async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const { browserHandoff: _browserHandoff, ...request } = handoffRequest();
      harness = await createReactDomHarness();
      await harness.render(createElement(ElicitationCard, { request, onSubmit }));

      const text = harness.dom.container.textContent ?? "";
      expect(text).toContain("Questions");
      expect(text).not.toContain("Browser needs you");
      expect(hasButton(harness.dom.container, "Open browser")).toBe(false);
      expect(hasButton(harness.dom.container, "Decline")).toBe(true);

      await harness.act(async () => {
        getReactProps(findButton(harness!.dom.container, "Done, continue"))?.onClick?.();
      });
      await harness.act(async () => {
        getReactProps(findAllByTag(harness!.dom.container, "FORM")[0])?.onSubmit?.({ preventDefault: vi.fn() });
      });
      await waitUntilAct(harness.act, () => onSubmit.mock.calls.length === 1);
      expect(onSubmit).toHaveBeenCalledWith("el-handoff", { action: "accept", content: { outcome: "done" } });
    });

    it("falls back to the ordinary form when a handoff has no field to answer with", async () => {
      const request: PendingElicitationRequestView = {
        ...handoffRequest(),
        requestedSchema: { type: "object", properties: {} },
      };
      harness = await createReactDomHarness();
      await harness.render(createElement(ElicitationCard, { request, onSubmit: vi.fn() }));
      expect(harness.dom.container.textContent).not.toContain("Browser needs you");
      expect(hasButton(harness.dom.container, "Submit answers")).toBe(true);
    });
  });

  it("shows the URL host and requires an explicit open action", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const request: PendingElicitationRequestView = {
      requestId: "el-url",
      message: "Authorize the provider",
      mode: "url",
      elicitationSource: "deployment-mcp",
      url: "https://accounts.example.com/authorize",
    };

    harness = await createReactDomHarness();
    await harness.render(createElement(ElicitationCard, { request, onSubmit }));

    expect(harness.dom.container.textContent).toContain("accounts.example.com");
    const link = findAllByTag(harness.dom.container, "A")[0];
    expect(getReactProps(link)?.href).toBe("https://accounts.example.com/authorize");
    expect(getReactProps(link)?.target).toBe("_blank");
    expect(onSubmit).not.toHaveBeenCalled();
    await harness.act(async () => {
      getReactProps(link)?.onClick?.({ preventDefault: vi.fn() });
    });
    await waitUntilAct(harness.act, () => onSubmit.mock.calls.length === 1);

    expect(onSubmit).toHaveBeenCalledWith("el-url", { action: "accept" });
  });
});
