import type ts from "typescript";

export const RELEASE_VERSION: RegExp;
export function compareReleaseVersions(left: string, right: string): number;
export function changelogSection(text: string, title: string): string[] | undefined;
export function latestReleaseTag(tags: string[], folder: string): { tag: string; version: string } | undefined;
export function directiveComments(source: string): string[];
export function isRealChange(typescript: typeof ts, path: string, before: string | Uint8Array | undefined, after: string | Uint8Array | undefined): boolean;
export function changelogVerdict(input: { changedFiles: string[]; changelog: string | undefined; version: string; baselineVersion: string }): { ok: boolean; detail: string };
export function changelogCheck(
  repoRoot: string,
  packages: { dir: string; manifest: { name: string; version: string } }[],
  log?: (line: string) => void,
): boolean;
