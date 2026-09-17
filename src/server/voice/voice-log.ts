// Per-conversation JSONL logs for diagnosing turn detection and latency.
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const MAX_LOG_FILES = 40;
const MAX_STRING_CHARS = 2_000;

function clip(value: unknown): unknown {
  if (typeof value === "string") return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map(clip);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, clip(entry)]));
  }
  return value;
}

export class VoiceLog {
  private stream?: WriteStream;
  private readonly startedAt = Date.now();
  readonly path: string;

  constructor(logsDir: string, conversationId: string) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.path = join(logsDir, `${stamp}-${conversationId.slice(0, 8)}.jsonl`);
    void mkdir(logsDir, { recursive: true }).then(() => {
      this.stream = createWriteStream(this.path, { flags: "a" });
      this.stream.on("error", () => {
        this.stream = undefined;
      });
    }).catch(() => undefined);
  }

  write(event: string, details: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ t: new Date().toISOString(), ms: Date.now() - this.startedAt, event, ...(clip(details) as Record<string, unknown>) });
    if (this.stream) {
      this.stream.write(`${line}\n`);
    } else {
      setTimeout(() => this.stream?.write(`${line}\n`), 50).unref();
    }
  }

  close(): void {
    const stream = this.stream;
    this.stream = undefined;
    stream?.end();
  }
}

export async function pruneVoiceLogs(logsDir: string, keep = MAX_LOG_FILES): Promise<number> {
  let entries: string[];
  try {
    entries = (await readdir(logsDir)).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return 0;
  }
  const stale = entries.slice(0, Math.max(0, entries.length - keep));
  await Promise.all(stale.map((name) => rm(join(logsDir, name), { force: true }).catch(() => undefined)));
  return stale.length;
}
