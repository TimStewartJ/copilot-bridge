import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PendingElicitationRequestView } from "../api";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
  type ReactDomHarness,
} from "../test-react-harness";
import ElicitationCard from "./ElicitationCard";

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
