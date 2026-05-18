import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consumeRestartSignalFile, parseRestartSignalContent, serializeRestartSignal } from "../restart-signal.js";
import { makeTestDir } from "./helpers.js";

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

  it("claims a signal by renaming it to the in-progress file before parsing", () => {
    const dir = makeTestDir("restart-signal-claim");
    const signalFile = join(dir, "restart.signal");
    const inProgressFile = join(dir, "restart-in-progress.json");
    writeFileSync(signalFile, serializeRestartSignal({
      validationMode: "operational",
      source: "self_restart",
      requestedAt: "2026-05-18T20:00:00.000Z",
    }));

    expect(consumeRestartSignalFile(signalFile, inProgressFile)).toEqual({
      requestedAt: "2026-05-18T20:00:00.000Z",
      validationMode: "operational",
      source: "self_restart",
    });
    expect(existsSync(signalFile)).toBe(false);
    expect(parseRestartSignalContent(readFileSync(inProgressFile, "utf-8"))).toEqual({
      requestedAt: "2026-05-18T20:00:00.000Z",
      validationMode: "operational",
      source: "self_restart",
    });
  });

  it("returns null when there is no signal to claim", () => {
    const dir = makeTestDir("restart-signal-missing");
    const signalFile = join(dir, "restart.signal");
    const inProgressFile = join(dir, "restart-in-progress.json");

    expect(consumeRestartSignalFile(signalFile, inProgressFile)).toBeNull();
    expect(existsSync(inProgressFile)).toBe(false);
  });

  it("replaces a stale in-progress signal when claiming a new signal", () => {
    const dir = makeTestDir("restart-signal-stale-in-progress");
    const signalFile = join(dir, "restart.signal");
    const inProgressFile = join(dir, "restart-in-progress.json");
    writeFileSync(inProgressFile, serializeRestartSignal({
      validationMode: "deploy",
      source: "stale",
    }));
    writeFileSync(signalFile, serializeRestartSignal({
      validationMode: "operational",
      source: "new",
      requestedAt: "2026-05-18T20:01:00.000Z",
    }));

    expect(consumeRestartSignalFile(signalFile, inProgressFile)).toEqual({
      requestedAt: "2026-05-18T20:01:00.000Z",
      validationMode: "operational",
      source: "new",
    });
    expect(existsSync(signalFile)).toBe(false);
    expect(parseRestartSignalContent(readFileSync(inProgressFile, "utf-8")).source).toBe("new");
  });
});
