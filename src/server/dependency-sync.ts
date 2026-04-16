import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

const ROOT_DEP_FILES = ["package.json", "package-lock.json"] as const;
const PATCHES_DIR = "patches";

export const DEPENDENCY_SYNC_PATHS = [...ROOT_DEP_FILES, PATCHES_DIR] as const;
export const DEPENDENCY_SYNC_GIT_PATHSPEC = DEPENDENCY_SYNC_PATHS.join(" ");

type PatchFile = { absPath: string; relPath: string };
type ParsedNameAndVersion = {
  packageName: string;
  version?: string;
  sequenceName?: string;
  sequenceNumber?: number;
};
type PatchTarget = { installPath: string; pathSpecifier: string };
type PreparedBackup = { packageName: string; originalDir: string; backupDir: string };

export type PreparedPatchedPackages = {
  packages: string[];
  restore(): void;
  discard(): void;
};

function collectPatchFiles(root: string, dir: string, entries: PatchFile[]): void {
  const dirEntries = readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of dirEntries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectPatchFiles(root, entryPath, entries);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".patch")) continue;

    entries.push({
      absPath: entryPath,
      relPath: relative(root, entryPath).split(sep).join("/"),
    });
  }
}

function getPatchFiles(root: string): PatchFile[] {
  const patchesDir = join(root, PATCHES_DIR);
  if (!existsSync(patchesDir)) return [];

  const entries: PatchFile[] = [];
  collectPatchFiles(root, patchesDir, entries);
  return entries;
}

function parseNameAndVersion(str: string): ParsedNameAndVersion | null {
  const parts = str
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return null;
  if (parts.length === 1) return { packageName: str };

  const versionIndex = parts.findIndex((part) => /^\d+\.\d+\.\d+.*$/.test(part));
  if (versionIndex === -1) {
    const [scope, name] = parts;
    return { packageName: `${scope}/${name}` };
  }

  const nameParts = parts.slice(0, versionIndex);
  let packageName: string;
  switch (nameParts.length) {
    case 0:
      return null;
    case 1:
      packageName = nameParts[0];
      break;
    case 2: {
      const [scope, name] = nameParts;
      packageName = `${scope}/${name}`;
      break;
    }
    default:
      return null;
  }

  const version = parts[versionIndex];
  const sequenceParts = parts.slice(versionIndex + 1);
  if (sequenceParts.length === 0) {
    return { packageName, version };
  }

  const sequenceNumber = parseInt(sequenceParts[0].replace(/^0+/, ""), 10);
  if (Number.isNaN(sequenceNumber)) return null;

  switch (sequenceParts.length) {
    case 1:
      return { packageName, version, sequenceNumber };
    case 2:
      return {
        packageName,
        version,
        sequenceName: sequenceParts[1],
        sequenceNumber,
      };
    default:
      return null;
  }
}

function getPatchTargetFromFilename(relPath: string): PatchTarget | null {
  const parts = basename(relPath)
    .replace(/(\.dev)?\.patch$/, "")
    .split("++")
    .map(parseNameAndVersion)
    .filter((part): part is ParsedNameAndVersion => part !== null);

  if (parts.length === 0) return null;
  if (!parts[parts.length - 1].version) return null;

  const packageNames = parts.map((part) => part.packageName);
  return {
    installPath: join("node_modules", packageNames.join("/node_modules/")),
    pathSpecifier: packageNames.join("/"),
  };
}

function getResetTargets(root: string): PatchTarget[] {
  const unique = new Map<string, PatchTarget>();
  for (const patchFile of getPatchFiles(root)) {
    const target = getPatchTargetFromFilename(patchFile.relPath);
    if (target) {
      unique.set(target.installPath, target);
    }
  }

  const sorted = [...unique.values()]
    .sort((a, b) => a.installPath.localeCompare(b.installPath));
  const selected: PatchTarget[] = [];

  for (const target of sorted) {
    const covered = selected.some((existing) =>
      target.installPath === existing.installPath ||
      target.installPath.startsWith(`${existing.installPath}${sep}`),
    );
    if (!covered) {
      selected.push(target);
    }
  }

  return selected;
}

export function preparePatchedPackagesForInstall(root: string): PreparedPatchedPackages {
  const targets = getResetTargets(root)
    .map((target) => ({
      target,
      originalDir: join(root, target.installPath),
    }))
    .filter(({ originalDir }) => existsSync(originalDir));

  if (targets.length === 0) {
    return {
      packages: [],
      restore() {},
      discard() {},
    };
  }

  const backupRoot = mkdtempSync(join(root, "node_modules", ".patch-package-backups-"));
  const backups: PreparedBackup[] = [];

  try {
    for (const { target, originalDir } of targets) {
      const backupDir = join(backupRoot, String(backups.length));
      renameSync(originalDir, backupDir);
      backups.push({
        packageName: target.pathSpecifier,
        originalDir,
        backupDir,
      });
    }
  } catch (error) {
    for (const backup of backups) {
      mkdirSync(dirname(backup.originalDir), { recursive: true });
      renameSync(backup.backupDir, backup.originalDir);
    }
    rmSync(backupRoot, { recursive: true, force: true });
    throw error;
  }

  let finalized = false;
  const finalize = (restore: boolean) => {
    if (finalized) return;
    finalized = true;

    if (restore) {
      for (const backup of backups) {
        rmSync(backup.originalDir, { recursive: true, force: true });
        mkdirSync(dirname(backup.originalDir), { recursive: true });
        renameSync(backup.backupDir, backup.originalDir);
      }
    }

    rmSync(backupRoot, { recursive: true, force: true });
  };

  return {
    packages: backups.map((backup) => backup.packageName),
    restore() {
      finalize(true);
    },
    discard() {
      finalize(false);
    },
  };
}

export function dependencySyncHash(root: string): string {
  const entries: string[] = [];

  for (const file of ROOT_DEP_FILES) {
    const filePath = join(root, file);
    const content = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
    entries.push(`${file}\0${content}`);
  }

  for (const patchFile of getPatchFiles(root)) {
    entries.push(`${patchFile.relPath}\0${readFileSync(patchFile.absPath, "utf-8")}`);
  }

  return createHash("sha256").update(entries.join("\0\0")).digest("hex");
}
