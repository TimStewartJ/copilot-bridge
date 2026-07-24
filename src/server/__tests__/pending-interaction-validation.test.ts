import { describe, expect, it } from "vitest";

import {
  normalizePendingElicitationRequest,
  normalizePendingUserInputRequest,
  validateElicitationResponse,
  validateUserInputResponse,
} from "../pending-interaction-validation.js";

describe("pending interaction validation", () => {
  it("normalizes SDK user input defaults and correlation data", () => {
    expect(normalizePendingUserInputRequest({
      requestId: " ui-1 ",
      question: " Continue? ",
      toolCallId: " tool-1 ",
    }, "2026-04-29T12:00:00.000Z")).toEqual({
      requestId: "ui-1",
      question: "Continue?",
      allowFreeform: true,
      toolCallId: "tool-1",
      requestedAt: "2026-04-29T12:00:00.000Z",
    });
  });

  it("validates choice and freeform user input responses", () => {
    const request = normalizePendingUserInputRequest({
      requestId: "ui-1",
      question: "Continue?",
      choices: ["yes", "no"],
      allowFreeform: false,
    });

    expect(validateUserInputResponse(request, {
      answer: "yes",
      wasFreeform: false,
    })).toEqual({
      answer: "yes",
      wasFreeform: false,
    });
    expect(() => validateUserInputResponse(request, {
      answer: "maybe",
      wasFreeform: false,
    })).toThrow("Choice responses must match one of the request choices");
    expect(() => validateUserInputResponse(request, {
      answer: "yes",
      wasFreeform: true,
    })).toThrow("Freeform answers are not allowed");
  });

  it("normalizes form and URL elicitation requests", () => {
    expect(normalizePendingElicitationRequest({
      requestId: "el-1",
      message: "Configure",
      requestedSchema: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["staging", "production"] },
        },
        required: ["target"],
      },
      elicitationSource: "deployment-mcp",
    })).toMatchObject({
      requestId: "el-1",
      message: "Configure",
      mode: "form",
      elicitationSource: "deployment-mcp",
    });

    expect(normalizePendingElicitationRequest({
      requestId: "el-2",
      message: "Authenticate",
      mode: "url",
      url: "https://example.com/login",
    })).toEqual({
      requestId: "el-2",
      message: "Authenticate",
      mode: "url",
      url: "https://example.com/login",
    });
  });

  it("rejects unsafe or malformed elicitation schemas", () => {
    expect(() => normalizePendingElicitationRequest({
      requestId: "el-1",
      message: "Configure",
      requestedSchema: {
        type: "object",
        properties: {
          ["__proto__"]: { type: "string" },
        },
      },
    })).toThrow();
    expect(() => normalizePendingElicitationRequest({
      requestId: "el-2",
      message: "Open",
      mode: "url",
      url: "http://example.com",
    })).toThrow("url must use HTTPS");
  });

  it("validates accepted form content against required fields and constraints", () => {
    const request = normalizePendingElicitationRequest({
      requestId: "el-1",
      message: "Configure",
      requestedSchema: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["staging", "production"] },
          replicas: { type: "integer", minimum: 1, maximum: 5 },
          notify: { type: "boolean" },
        },
        required: ["target", "replicas"],
      },
    });

    expect(validateElicitationResponse(request, {
      action: "accept",
      content: {
        target: "staging",
        replicas: 2,
        notify: true,
      },
    })).toEqual({
      action: "accept",
      content: {
        target: "staging",
        replicas: 2,
        notify: true,
      },
    });
    expect(() => validateElicitationResponse(request, {
      action: "accept",
      content: { target: "staging" },
    })).toThrow("missing required field replicas");
    expect(() => validateElicitationResponse(request, {
      action: "accept",
      content: { target: "staging", replicas: 8 },
    })).toThrow("replicas must be at most 5");
  });

  it("preserves accept, decline, and cancel semantics", () => {
    const form = normalizePendingElicitationRequest({
      requestId: "el-1",
      message: "Configure",
      requestedSchema: { type: "object", properties: {} },
    });
    expect(validateElicitationResponse(form, {
      action: "accept",
      content: {},
    })).toEqual({ action: "accept", content: {} });
    expect(validateElicitationResponse(form, { action: "decline" })).toEqual({ action: "decline" });
    expect(validateElicitationResponse(form, { action: "cancel" })).toEqual({ action: "cancel" });
    expect(() => validateElicitationResponse(form, {
      action: "cancel",
      content: {},
    })).toThrow("Declined or canceled responses cannot include content");
  });
});
