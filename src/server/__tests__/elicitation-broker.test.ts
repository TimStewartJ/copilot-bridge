import { describe, expect, it, vi } from "vitest";

import {
  ElicitationBroker,
  ElicitationBrokerError,
} from "../elicitation-broker.js";
import { MAX_ELICITATION_SCHEMA_LENGTH } from "../elicitation-types.js";

const REQUESTED_AT = "2026-07-13T12:00:00.000Z";

function createBroker(ids: string[] = ["el_1", "el_2"]): ElicitationBroker {
  let nextId = 0;
  return new ElicitationBroker({
    requestIdFactory: () => ids[nextId++] ?? `el_extra_${nextId}`,
    now: () => new Date(REQUESTED_AT),
  });
}

describe("elicitation-broker", () => {
  it("normalizes a native form schema and resolves validated content", async () => {
    const broker = createBroker(["el_form"]);
    const promise = broker.requestElicitation({
      sessionId: " session-1 ",
      message: "Configure deployment",
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
            minLength: 3,
            maxLength: 100,
          },
          retries: {
            type: "integer",
            minimum: 0,
            maximum: 5,
            default: 1,
          },
          notify: {
            type: "boolean",
            default: true,
          },
          checks: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              enum: ["unit", "integration"],
            },
            default: ["unit"],
          },
        },
        required: ["target", "reason"],
      },
    });

    expect(broker.listPending("session-1")).toEqual([
      {
        requestId: "el_form",
        message: "Configure deployment",
        mode: "form",
        requestedAt: REQUESTED_AT,
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
              minLength: 3,
              maxLength: 100,
            },
            retries: {
              type: "integer",
              minimum: 0,
              maximum: 5,
              default: 1,
            },
            notify: {
              type: "boolean",
              default: true,
            },
            checks: {
              type: "array",
              minItems: 1,
              items: {
                type: "string",
                enum: ["unit", "integration"],
              },
              default: ["unit"],
            },
          },
          required: ["target", "reason"],
        },
      },
    ]);

    const result = broker.submitResponse("session-1", "el_form", {
      action: "accept",
      content: {
        target: "production",
        reason: "Needed for release",
        retries: 2,
        notify: false,
        checks: ["unit", "integration"],
      },
    });

    expect(result).toEqual({
      action: "accept",
      content: {
        target: "production",
        reason: "Needed for release",
        retries: 2,
        notify: false,
        checks: ["unit", "integration"],
      },
    });
    await expect(promise).resolves.toEqual(result);
    expect(broker.getPendingCount("session-1")).toBe(0);
  });

  it("supports titled choices and HTTPS URL elicitation", async () => {
    const broker = createBroker(["el_choices", "el_url"]);
    const choicePromise = broker.requestElicitation({
      sessionId: "session-1",
      message: "Pick a provider",
      elicitationSource: "example-mcp",
      requestedSchema: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            oneOf: [
              { const: "gh", title: "GitHub" },
              { const: "gl", title: "GitLab" },
            ],
          },
          scopes: {
            type: "array",
            items: {
              anyOf: [
                { const: "repo", title: "Repositories" },
                { const: "issues", title: "Issues" },
              ],
            },
          },
        },
        required: ["provider"],
      },
    });
    const urlPromise = broker.requestElicitation({
      sessionId: "session-1",
      mode: "url",
      message: "Authorize the deployment provider",
      elicitationSource: "example-mcp",
      url: "https://example.com/authorize?flow=1",
    });

    expect(broker.listPending("session-1")[1]).toMatchObject({
      requestId: "el_url",
      mode: "url",
      url: "https://example.com/authorize?flow=1",
      elicitationSource: "example-mcp",
    });

    broker.submitResponse("session-1", "el_choices", {
      action: "accept",
      content: {
        provider: "gh",
        scopes: ["repo"],
      },
    });
    broker.submitResponse("session-1", "el_url", { action: "accept" });

    await expect(choicePromise).resolves.toMatchObject({
      action: "accept",
      content: { provider: "gh", scopes: ["repo"] },
    });
    await expect(urlPromise).resolves.toEqual({ action: "accept" });
  });

  it("keeps requests pending after invalid responses", async () => {
    const broker = createBroker(["el_invalid"]);
    const promise = broker.requestElicitation({
      sessionId: "session-1",
      message: "Configure",
      requestedSchema: {
        type: "object",
        properties: {
          environment: {
            type: "string",
            enum: ["staging", "production"],
          },
          contact: {
            type: "string",
            format: "email",
          },
        },
        required: ["environment", "contact"],
      },
    });

    expect(() => broker.submitResponse("session-1", "el_invalid", {
      action: "accept",
      content: { environment: "invalid", contact: "not-an-email" },
    })).toThrow("must match one of the available options");
    expect(() => broker.submitResponse("session-1", "el_invalid", {
      action: "accept",
      content: { environment: "staging" },
    })).toThrow("missing required field contact");
    expect(() => broker.submitResponse("session-1", "el_invalid", {
      action: "decline",
      content: {},
    })).toThrow("cannot include content");
    expect(broker.getPendingCount("session-1")).toBe(1);

    broker.submitResponse("session-1", "el_invalid", { action: "decline" });
    await expect(promise).resolves.toEqual({ action: "decline" });
  });

  it("rejects unsafe schemas and URLs before storing them", () => {
    const broker = createBroker();

    expect(() => broker.requestElicitation({
      sessionId: "session-1",
      message: "Unsafe",
      requestedSchema: {
        type: "object",
        properties: JSON.parse('{"__proto__":{"type":"string"}}'),
      },
    })).toThrow();
    expect(() => broker.requestElicitation({
      sessionId: "session-1",
      message: "Unsupported",
      requestedSchema: {
        type: "object",
        properties: {
          nested: { type: "object" } as any,
        },
      },
    })).toThrow("type is unsupported");
    expect(() => broker.requestElicitation({
      sessionId: "session-1",
      mode: "url",
      message: "Unsafe URL",
      url: "http://example.com/authorize",
    })).toThrow("must use HTTPS");
    expect(() => broker.requestElicitation({
      sessionId: "session-1",
      mode: "url",
      message: "Credentials",
      url: "https://user:pass@example.com/authorize",
    })).toThrow("embedded credentials");
    expect(broker.getPendingCount()).toBe(0);
  });

  it("preserves opaque property names, option values, and user text", async () => {
    const broker = createBroker(["el_preserve"]);
    const promise = broker.requestElicitation({
      sessionId: "session-1",
      message: "Preserve values",
      requestedSchema: {
        type: "object",
        properties: {
          " target ": {
            type: "string",
            enum: [" staging ", "production"],
          },
          reason: {
            type: "string",
          },
        },
        required: [" target ", "reason"],
      },
    });

    const result = broker.submitResponse("session-1", "el_preserve", {
      action: "accept",
      content: {
        " target ": " staging ",
        reason: "  keep my spacing  ",
      },
    });

    expect(result).toEqual({
      action: "accept",
      content: {
        " target ": " staging ",
        reason: "  keep my spacing  ",
      },
    });
    await expect(promise).resolves.toEqual(result);
  });

  it("enforces an aggregate schema size budget", () => {
    const broker = createBroker();
    const largeProperties = Object.fromEntries(
      Array.from({ length: 3 }, (_, fieldIndex) => [
        `field_${fieldIndex}`,
        {
          type: "string",
          enum: Array.from(
            { length: 50 },
            (_, optionIndex) => `${fieldIndex}_${optionIndex}_${"x".repeat(900)}`,
          ),
        },
      ]),
    );

    expect(JSON.stringify({ properties: largeProperties }).length)
      .toBeGreaterThan(MAX_ELICITATION_SCHEMA_LENGTH);
    expect(() => broker.requestElicitation({
      sessionId: "session-1",
      message: "Too large",
      requestedSchema: {
        type: "object",
        properties: largeProperties as any,
      },
    })).toThrow(`at most ${MAX_ELICITATION_SCHEMA_LENGTH} characters`);
  });

  it("allows confirmation-only forms with empty properties", async () => {
    const broker = createBroker(["el_confirm"]);
    const promise = broker.requestElicitation({
      sessionId: "session-1",
      message: "Continue with deployment?",
      requestedSchema: {
        type: "object",
        properties: {},
      },
    });

    broker.submitResponse("session-1", "el_confirm", {
      action: "accept",
      content: {},
    });
    await expect(promise).resolves.toEqual({ action: "accept", content: {} });
  });

  it("requires RFC3339 timezone information for date-time fields", async () => {
    const broker = createBroker(["el_datetime"]);
    const promise = broker.requestElicitation({
      sessionId: "session-1",
      message: "Schedule",
      requestedSchema: {
        type: "object",
        properties: {
          runAt: {
            type: "string",
            format: "date-time",
          },
        },
        required: ["runAt"],
      },
    });

    expect(() => broker.submitResponse("session-1", "el_datetime", {
      action: "accept",
      content: { runAt: "2026-07-13T14:30" },
    })).toThrow("valid date-time");
    broker.submitResponse("session-1", "el_datetime", {
      action: "accept",
      content: { runAt: "2026-07-13T14:30:00Z" },
    });
    await expect(promise).resolves.toMatchObject({
      content: { runAt: "2026-07-13T14:30:00Z" },
    });
  });

  it("resolves lifecycle cancellation normally without exposing content", async () => {
    const onRequestCanceled = vi.fn();
    const broker = new ElicitationBroker({
      requestIdFactory: () => "el_cancel",
      now: () => new Date(REQUESTED_AT),
      onRequestCanceled,
    });
    const promise = broker.requestElicitation({
      sessionId: "session-1",
      message: "Cancel me",
      requestedSchema: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
      },
    });

    expect(broker.cancelSessionRequests("session-1", "session_ended", "Run stopped")).toBe(1);
    await expect(promise).resolves.toEqual({ action: "cancel" });
    expect(onRequestCanceled).toHaveBeenCalledWith(
      "session-1",
      "el_cancel",
      "session_ended",
      "Run stopped",
      REQUESTED_AT,
    );
  });

  it("accepts only the first response", async () => {
    const broker = createBroker(["el_once"]);
    const promise = broker.requestElicitation({
      sessionId: "session-1",
      message: "Once",
      requestedSchema: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
      },
    });

    broker.submitResponse("session-1", "el_once", {
      action: "accept",
      content: { value: "first" },
    });
    expect(() => broker.submitResponse("session-1", "el_once", {
      action: "accept",
      content: { value: "second" },
    })).toThrowError(ElicitationBrokerError);
    await expect(promise).resolves.toMatchObject({
      action: "accept",
      content: { value: "first" },
    });
  });
});
