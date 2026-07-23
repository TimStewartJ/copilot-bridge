import type { Dirent, Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export type SessionStorageMeasurementStatus = "complete" | "missing" | "partial";

export interface SessionStorageWarning {
  code: "missing" | "partial";
  message: string;
}

export interface SessionStorageMeasurement {
  status: SessionStorageMeasurementStatus;
  diskSizeBytes: number;
  warning?: SessionStorageWarning;
}

export interface SessionStorageReader {
  measureSession(sessionId: string): Promise<SessionStorageMeasurement>;
}

export interface SessionStorageFileSystem {
  readdir(dirPath: string): Promise<Dirent[]>;
  stat(filePath: string): Promise<Pick<Stats, "size">>;
}

export interface SessionStorageReaderOptions {
  concurrency?: number;
  fs?: Partial<SessionStorageFileSystem>;
}

export const DEFAULT_SESSION_STORAGE_CONCURRENCY = 8;

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_SESSION_STORAGE_CONCURRENCY;
  }
  return Math.max(1, Math.floor(value));
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function createLimiter(concurrency: number): <T>(operation: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queued: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (active < concurrency) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => queued.push(resolve));
  }

  function release(): void {
    const next = queued.shift();
    if (next) {
      next();
    } else {
      active -= 1;
    }
  }

  return async <T>(operation: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

export function createSessionStorageReader(
  sessionStateDir: string,
  options: SessionStorageReaderOptions = {},
): SessionStorageReader {
  const fileSystem: SessionStorageFileSystem = {
    readdir: (dirPath) => readdir(dirPath, { withFileTypes: true }),
    stat,
    ...options.fs,
  };
  const runFileSystemOperation = createLimiter(normalizeConcurrency(options.concurrency));

  return {
    async measureSession(sessionId): Promise<SessionStorageMeasurement> {
      const sessionDir = join(sessionStateDir, sessionId);
      let diskSizeBytes = 0;
      let failedOperations = 0;
      let firstErrorCode: string | undefined;
      let rootMissing = false;

      function recordFailure(error: unknown): void {
        failedOperations += 1;
        firstErrorCode ??= getErrorCode(error);
      }

      async function measureDirectory(dirPath: string, isRoot: boolean): Promise<void> {
        let entries: Dirent[];
        try {
          entries = await runFileSystemOperation(() => fileSystem.readdir(dirPath));
        } catch (error) {
          if (isRoot && getErrorCode(error) === "ENOENT") {
            rootMissing = true;
          } else {
            recordFailure(error);
          }
          return;
        }

        await Promise.all(entries.map(async (entry) => {
          const entryPath = join(dirPath, entry.name);
          if (entry.isDirectory()) {
            await measureDirectory(entryPath, false);
            return;
          }

          try {
            const entryStat = await runFileSystemOperation(() => fileSystem.stat(entryPath));
            diskSizeBytes += entryStat.size;
          } catch (error) {
            recordFailure(error);
          }
        }));
      }

      await measureDirectory(sessionDir, true);

      if (rootMissing) {
        return {
          status: "missing",
          diskSizeBytes: 0,
          warning: {
            code: "missing",
            message: "Session storage directory is missing.",
          },
        };
      }

      if (failedOperations > 0) {
        const operationLabel = failedOperations === 1 ? "operation" : "operations";
        const errorSuffix = firstErrorCode ? ` First error: ${firstErrorCode}.` : "";
        return {
          status: "partial",
          diskSizeBytes,
          warning: {
            code: "partial",
            message: `Session storage size is partial because ${failedOperations} filesystem ${operationLabel} failed.${errorSuffix}`,
          },
        };
      }

      return {
        status: "complete",
        diskSizeBytes,
      };
    },
  };
}
