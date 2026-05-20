import { afterEach, beforeEach, vi } from "vitest";
import { get } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import request from "supertest";
import type { Express } from "express";
import { join } from "node:path";
import type { AppContext } from "../app-context.js";
import type { DatabaseSync } from "../db.js";
import type { DeferredPromptRunner } from "../deferred-prompt-runner.js";
import { publishOutboundAttachment } from "../outbound-attachments.js";
import { writeRestartState } from "../restart-state.js";
import { clearRestartPending, RESTART_PENDING_MESSAGE } from "../session-manager.js";
import * as scheduler from "../scheduler.js";
import * as providers from "../providers/index.js";
import { UserInputBrokerError } from "../user-input-broker.js";
import { createMockSessionManager, createMockTranscriptionService, createTestApp, makeTestDir, makeTestRuntimePaths } from "./helpers.js";

export { request, get, mkdirSync, writeFileSync, join };
export { publishOutboundAttachment, writeRestartState, RESTART_PENDING_MESSAGE, scheduler, providers, UserInputBrokerError };
export { createMockSessionManager, createMockTranscriptionService, createTestApp, makeTestDir };
export type { DeferredPromptRunner };

export interface ApiRouteTestState {
  app: Express;
  ctx: AppContext;
  db: DatabaseSync;
}

const TRANSCRIPTION_ENV_KEYS = [
  "BRIDGE_TRANSCRIPTION_PROVIDER",
  "BRIDGE_TRANSCRIPTION_TIMEOUT_MS",
  "BRIDGE_TRANSCRIPTION_MAX_DURATION_SECONDS",
  "BRIDGE_WHISPER_CPP_COMMAND",
  "BRIDGE_WHISPER_CPP_MODEL",
  "BRIDGE_WHISPER_CPP_LANGUAGE",
  "BRIDGE_WHISPER_CPP_ARGS_JSON",
  "BRIDGE_WHISPER_CPP_NO_GPU",
] as const;

export function installApiRouteTestHooks(assign: (state: ApiRouteTestState) => void): void {
  beforeEach(() => {
    clearRestartPending();
    for (const key of TRANSCRIPTION_ENV_KEYS) {
      vi.stubEnv(key, undefined);
    }
    assign(createTestApp());
  });

  afterEach(() => {
    vi.useRealTimers();
    clearRestartPending();
    scheduler.shutdown();
  });
}

export function createCopilotUsageTestHome(options?: { dotDir?: boolean }): string {
  const rootDir = makeTestDir("api-copilot-usage");
  if (options?.dotDir) {
    const copilotHome = join(rootDir, ".copilot");
    mkdirSync(copilotHome, { recursive: true });
    return copilotHome;
  }
  return rootDir;
}

export function writeCopilotUsageEvents(copilotHome: string, sessionId: string, events: unknown[]): void {
  const sessionDir = join(copilotHome, "session-state", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "events.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
}

export function writeRawCopilotUsageEvents(copilotHome: string, sessionId: string, lines: string[]): void {
  const sessionDir = join(copilotHome, "session-state", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "events.jsonl"), `${lines.join("\n")}\n`);
}

export function createRestartRuntimePaths() {
  return makeTestRuntimePaths("api-restart");
}

export function createWavBuffer(durationSeconds: number, sampleRate = 16_000): Buffer {
  const channelCount = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const sampleCount = Math.max(1, Math.ceil(durationSeconds * sampleRate));
  const dataSize = sampleCount * channelCount * bytesPerSample;
  const byteRate = sampleRate * channelCount * bytesPerSample;
  const blockAlign = channelCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

async function flushTestMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

export async function eventually(
  assertion: () => void | Promise<void>,
  options: { maxAttempts?: number } = {},
): Promise<void> {
  // Deterministic retries only: callers that depend on timers should advance
  // fake timers or await an explicit operation inside the assertion.
  const maxAttempts = options.maxAttempts ?? 50;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await flushTestMicrotasks();
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
