import { describe, expect, it } from "vitest";
import { UserInputBroker, UserInputBrokerError } from "../user-input-broker.js";

const REQUESTED_AT = "2026-04-29T12:00:00.000Z";

function createBroker(ids: string[] = ["ui_1", "ui_2", "ui_3"]): UserInputBroker {
  let nextId = 0;
  return new UserInputBroker({
    requestIdFactory: () => ids[nextId++] ?? `ui_extra_${nextId}`,
    now: () => new Date(REQUESTED_AT),
  });
}

function firstPendingId(broker: UserInputBroker, sessionId = "session-1"): string {
  const pending = broker.listPendingUserInputs(sessionId);
  expect(pending).toHaveLength(1);
  return pending[0].requestId;
}

describe("user-input-broker", () => {
  it("creates pending requests with bridge IDs and normalized request views", () => {
    const broker = createBroker(["ui_request"]);
    const promise = broker.requestUserInput(" session-1 ", {
      question: " Pick one ",
      choices: [" yes ", "no"],
      allowFreeform: false,
      toolCallId: " tool-1 ",
    });

    const pending = broker.listPendingUserInputs("session-1");
    expect(pending).toEqual([
      {
        requestId: "ui_request",
        question: "Pick one",
        choices: ["yes", "no"],
        allowFreeform: false,
        requestedAt: REQUESTED_AT,
        toolCallId: "tool-1",
      },
    ]);
    expect(broker.getPendingUserInput("session-1", "ui_request")).toEqual(pending[0]);

    broker.submitUserInputResponse("session-1", "ui_request", { answer: "yes", wasFreeform: false });
    return expect(promise).resolves.toEqual({ answer: "yes", wasFreeform: false });
  });

  it("resolves the first valid answer and removes the request", async () => {
    const broker = createBroker(["ui_first"]);
    const promise = broker.requestUserInput("session-1", {
      question: "Continue?",
      choices: ["yes", "no"],
      allowFreeform: false,
    });

    const response = broker.submitUserInputResponse("session-1", "ui_first", {
      answer: "yes",
      wasFreeform: false,
    });

    expect(response).toEqual({ answer: "yes", wasFreeform: false });
    expect(broker.listPendingUserInputs("session-1")).toEqual([]);
    await expect(promise).resolves.toEqual({ answer: "yes", wasFreeform: false });
    expect(() => broker.submitUserInputResponse("session-1", "ui_first", {
      answer: "no",
      wasFreeform: false,
    })).toThrowError(UserInputBrokerError);
  });

  it("rejects invalid responses without completing the pending request", async () => {
    const broker = createBroker(["ui_invalid"]);
    const promise = broker.requestUserInput("session-1", {
      question: "Continue?",
      choices: ["yes", "no"],
      allowFreeform: false,
    });

    expect(() => broker.submitUserInputResponse("session-1", "ui_invalid", {
      answer: "maybe",
      wasFreeform: false,
    })).toThrow("Choice responses must match one of the request choices");
    expect(() => broker.submitUserInputResponse("session-1", "ui_invalid", {
      answer: "   ",
      wasFreeform: true,
    })).toThrow("Response answer cannot be blank");
    expect(broker.getPendingCount("session-1")).toBe(1);

    broker.submitUserInputResponse("session-1", "ui_invalid", {
      answer: "no",
      wasFreeform: false,
    });
    await expect(promise).resolves.toEqual({ answer: "no", wasFreeform: false });
  });

  it("allows freeform answers only when the pending request allows them", async () => {
    const broker = createBroker(["ui_freeform", "ui_no_freeform"]);
    const freeformPromise = broker.requestUserInput("session-1", {
      question: "Explain",
      choices: ["short"],
      allowFreeform: true,
    });
    const noFreeformPromise = broker.requestUserInput("session-1", {
      question: "Pick",
      choices: ["short"],
      allowFreeform: false,
    });

    broker.submitUserInputResponse("session-1", "ui_freeform", {
      answer: "a longer answer",
      wasFreeform: true,
    });
    expect(() => broker.submitUserInputResponse("session-1", "ui_no_freeform", {
      answer: "short",
      wasFreeform: true,
    })).toThrow("Freeform answers are not allowed for this request");
    broker.submitUserInputResponse("session-1", "ui_no_freeform", {
      answer: "short",
      wasFreeform: false,
    });

    await expect(freeformPromise).resolves.toEqual({ answer: "a longer answer", wasFreeform: true });
    await expect(noFreeformPromise).resolves.toEqual({ answer: "short", wasFreeform: false });
  });

  it("requires non-freeform choice answers to match an available choice", async () => {
    const broker = createBroker(["ui_choice"]);
    const promise = broker.requestUserInput("session-1", {
      question: "Pick",
      choices: ["A", "B"],
      allowFreeform: true,
    });

    expect(() => broker.submitUserInputResponse("session-1", "ui_choice", {
      answer: "C",
      wasFreeform: false,
    })).toThrow("Choice responses must match one of the request choices");

    broker.submitUserInputResponse("session-1", "ui_choice", {
      answer: "C",
      wasFreeform: true,
    });
    await expect(promise).resolves.toEqual({ answer: "C", wasFreeform: true });
  });

  it("cancels all pending requests for a session", async () => {
    const broker = createBroker(["ui_a", "ui_b", "ui_other"]);
    const first = broker.requestUserInput("session-1", { question: "First?" });
    const second = broker.requestUserInput("session-1", { question: "Second?" });
    const other = broker.requestUserInput("session-2", { question: "Other?" });
    const firstRejected = expect(first).rejects.toMatchObject({
      code: "request_canceled",
      reason: "session_ended",
    });
    const secondRejected = expect(second).rejects.toMatchObject({
      code: "request_canceled",
      reason: "session_ended",
    });

    expect(broker.cancelSessionRequests("session-1")).toBe(2);
    expect(broker.listPendingUserInputs("session-1")).toEqual([]);
    expect(broker.listPendingUserInputs("session-2")).toHaveLength(1);
    await firstRejected;
    await secondRejected;

    broker.submitUserInputResponse("session-2", "ui_other", { answer: "still here", wasFreeform: true });
    await expect(other).resolves.toEqual({ answer: "still here", wasFreeform: true });
  });

  it("cancels a single pending request", async () => {
    const broker = createBroker(["ui_one"]);
    const promise = broker.requestUserInput("session-1", { question: "Cancel me?" });
    const rejected = expect(promise).rejects.toMatchObject({
      code: "request_canceled",
      reason: "superseded",
    });

    expect(broker.cancelUserInputRequest("session-1", "ui_one", "superseded")).toBe(true);
    expect(broker.cancelUserInputRequest("session-1", "ui_one", "superseded")).toBe(false);
    expect(broker.getPendingCount()).toBe(0);
    await rejected;
  });

  it("rejects invalid requests before storing them", () => {
    const broker = createBroker(["ui_invalid_request"]);

    expect(() => broker.requestUserInput("session-1", {
      question: "Pick",
      choices: ["same", " same "],
    })).toThrow("choices cannot contain duplicates after trimming");
    expect(() => broker.requestUserInput("session-1", {
      question: "Pick",
      choices: [" "],
    })).toThrow("choices cannot contain blank values");
    expect(() => broker.requestUserInput("session-1", {
      question: "No choices",
      allowFreeform: false,
    })).toThrow("User input requests without choices must allow freeform answers");
    expect(broker.getPendingCount()).toBe(0);
  });

  it("retries request ID generation on pending collisions", () => {
    const broker = createBroker(["ui_same", "ui_same", "ui_next"]);
    const first = broker.requestUserInput("session-1", { question: "First?" });
    const second = broker.requestUserInput("session-2", { question: "Second?" });

    expect(firstPendingId(broker, "session-1")).toBe("ui_same");
    expect(firstPendingId(broker, "session-2")).toBe("ui_next");

    broker.submitUserInputResponse("session-1", "ui_same", { answer: "one", wasFreeform: true });
    broker.submitUserInputResponse("session-2", "ui_next", { answer: "two", wasFreeform: true });
    return Promise.all([
      expect(first).resolves.toEqual({ answer: "one", wasFreeform: true }),
      expect(second).resolves.toEqual({ answer: "two", wasFreeform: true }),
    ]);
  });
});
