import { describe, expect, it } from "vitest";
import { parseRestartSignalContent, serializeRestartSignal } from "../restart-signal.js";

describe("restart signal parsing", () => {
  it("round-trips typed operational restart signals", () => {
    const content = serializeRestartSignal({
      validationMode: "operational",
      source: "self_restart",
      requestedAt: "2026-05-14T20:00:00.000Z",
    });

    expect(parseRestartSignalContent(content)).toEqual({
      requestedAt: "2026-05-14T20:00:00.000Z",
      validationMode: "operational",
      source: "self_restart",
    });
  });

  it("keeps legacy timestamp signals on deploy validation", () => {
    expect(parseRestartSignalContent("2026-05-14T20:00:00.000Z\n")).toEqual({
      requestedAt: "2026-05-14T20:00:00.000Z",
      validationMode: "deploy",
    });
  });

  it("defaults malformed typed signals to deploy validation", () => {
    expect(parseRestartSignalContent('{"validationMode":"oper')).toMatchObject({
      validationMode: "deploy",
    });
    expect(parseRestartSignalContent('{"validationMode":"unknown"}')).toMatchObject({
      validationMode: "deploy",
    });
  });
});
