import { statSync } from "node:fs";
import { stat as statAsync } from "node:fs/promises";

export interface WorkspaceAvailability {
  cwd: string;
  available: boolean;
  clearStalePin: boolean;
}

export type WorkspaceAvailabilityLookup = (cwd?: string | null) => Promise<WorkspaceAvailability | undefined>;

function getFsErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function normalizeWorkspaceCwd(cwd?: string | null): string | undefined {
  const normalized = cwd?.trim();
  return normalized || undefined;
}

export function getWorkspaceAvailability(cwd?: string | null): WorkspaceAvailability | undefined {
  const normalized = normalizeWorkspaceCwd(cwd);
  if (!normalized) return undefined;
  try {
    return {
      cwd: normalized,
      available: statSync(normalized).isDirectory(),
      clearStalePin: true,
    };
  } catch (error) {
    const code = getFsErrorCode(error);
    return {
      cwd: normalized,
      available: false,
      clearStalePin: code === "ENOENT" || code === "ENOTDIR",
    };
  }
}

async function getWorkspaceAvailabilityAsync(cwd?: string | null): Promise<WorkspaceAvailability | undefined> {
  const normalized = normalizeWorkspaceCwd(cwd);
  if (!normalized) return undefined;
  try {
    return {
      cwd: normalized,
      available: (await statAsync(normalized)).isDirectory(),
      clearStalePin: true,
    };
  } catch (error) {
    const code = getFsErrorCode(error);
    return {
      cwd: normalized,
      available: false,
      clearStalePin: code === "ENOENT" || code === "ENOTDIR",
    };
  }
}

export function createWorkspaceAvailabilityLookup(): WorkspaceAvailabilityLookup {
  const cache = new Map<string, Promise<WorkspaceAvailability | undefined>>();
  return (cwd?: string | null) => {
    const normalized = normalizeWorkspaceCwd(cwd);
    if (!normalized) return Promise.resolve(undefined);

    let promise = cache.get(normalized);
    if (!promise) {
      promise = getWorkspaceAvailabilityAsync(normalized);
      cache.set(normalized, promise);
    }
    return promise;
  };
}

export function resolveAvailableWorkspaceCwd(cwd?: string | null): string | undefined {
  const availability = getWorkspaceAvailability(cwd);
  return availability?.available ? availability.cwd : undefined;
}

export async function resolveAvailableWorkspaceCwdAsync(
  cwd: string | undefined,
  getAvailability: WorkspaceAvailabilityLookup,
): Promise<string | undefined> {
  const availability = await getAvailability(cwd);
  return availability?.available ? availability.cwd : undefined;
}
