import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimePaths } from "./runtime-paths.js";

export interface PathComparisonApi {
  resolve: (...paths: string[]) => string;
  sep: string;
}

export interface PathComparisonOptions {
  platform?: NodeJS.Platform;
  pathApi?: PathComparisonApi;
}

export interface LocalStagingPathApi extends PathComparisonApi {
  basename: (path: string) => string;
  dirname: (path: string) => string;
}

export interface LocalStagingModuleOptions extends PathComparisonOptions {
  modulePath?: string;
  pathApi?: LocalStagingPathApi;
}

interface LocalStagingContext {
  runtimePaths?: Pick<RuntimePaths, "dataDir">;
}

const nativePathApi: LocalStagingPathApi = {
  basename,
  dirname,
  resolve,
  sep,
};

function normalizeResolvedPath(filePath: string, options: PathComparisonOptions): string {
  const pathApi = options.pathApi ?? nativePathApi;
  const resolvedPath = pathApi.resolve(filePath);
  const platform = options.platform ?? process.platform;
  return platform === "win32" || platform === "darwin"
    ? resolvedPath.toLowerCase()
    : resolvedPath;
}

export function pathsEqual(
  firstPath: string,
  secondPath: string,
  options: PathComparisonOptions = {},
): boolean {
  return normalizeResolvedPath(firstPath, options) === normalizeResolvedPath(secondPath, options);
}

export function isPathAtOrUnder(
  parentPath: string,
  candidatePath: string,
  options: PathComparisonOptions = {},
): boolean {
  const normalizedParent = normalizeResolvedPath(parentPath, options);
  const normalizedCandidate = normalizeResolvedPath(candidatePath, options);
  const pathApi = options.pathApi ?? nativePathApi;
  const parentWithSeparator = normalizedParent.endsWith(pathApi.sep)
    ? normalizedParent
    : `${normalizedParent}${pathApi.sep}`;
  return normalizedCandidate === normalizedParent
    || normalizedCandidate.startsWith(parentWithSeparator);
}

export function isLocalStagingModule(
  ctx: LocalStagingContext,
  options: LocalStagingModuleOptions = {},
): boolean {
  const dataDir = ctx.runtimePaths?.dataDir;
  if (!dataDir) return false;
  const pathApi = options.pathApi ?? nativePathApi;
  if (pathApi.basename(dataDir) !== "data") return false;

  try {
    const modulePath = options.modulePath ?? fileURLToPath(import.meta.url);
    return isPathAtOrUnder(pathApi.dirname(dataDir), modulePath, {
      platform: options.platform,
      pathApi,
    });
  } catch {
    return false;
  }
}
