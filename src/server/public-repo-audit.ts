import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The repository is public. These rules name what is allowed rather than what is not, so a package
// host or Azure DevOps org nobody thought of still fails and no private value has to live here.
// Private terms belong in the deploy guards' denylist, which stays outside the repository.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC_NPM_HOST = "registry.npmjs.org";
const EXAMPLE_ADO_ORGS = new Set(["acme", "example", "exampleorg", "org", "other", "otherorg"]);
const SCANNED_DIRS = [".github", "scripts", "skills", "src"];
const SCANNED_ROOT_FILES = [".env.example", "AGENTS.md", "README.md", "package.json"];
const TEXT_EXTENSIONS = new Set([".css", ".html", ".json", ".md", ".mjs", ".ps1", ".ts", ".tsx", ".yml"]);
const SKIPPED_DIRS = new Set(["dist", "node_modules"]);
const ADO_ORG_PATTERNS = [
  /\bdev\.azure\.com\/([A-Za-z0-9_-]+)/g,
  /(?<![\w.-])([A-Za-z0-9_-]+)\.visualstudio\.com/g,
];
// npm records the host it downloaded from, so an install through a mirror writes the mirror's
// address here. The package path after the host is the same on the public registry.
const OFF_HOST_RESOLVED =
  /("resolved":\s*")https?:\/\/(?!registry\.npmjs\.org\/)[^"]*?\/((?:@[^/"]+\/)?[^/"]+\/-\/[^/"]+\.tgz)(")/g;

export function findLockfileHosts(lockfileText: string): string[] {
  const packages = (JSON.parse(lockfileText) as { packages?: Record<string, { resolved?: unknown }> }).packages ?? {};
  const hosts: string[] = [];
  for (const entry of Object.values(packages)) {
    if (typeof entry.resolved !== "string" || !/^https?:\/\//.test(entry.resolved)) continue;
    const { host } = new URL(entry.resolved);
    if (host !== PUBLIC_NPM_HOST) hosts.push(host);
  }
  return hosts;
}

export function normalizeLockfile(lockfileText: string): string {
  return lockfileText.replace(OFF_HOST_RESOLVED, `$1https://${PUBLIC_NPM_HOST}/$2$3`);
}

export function findAdoOrgs(text: string): Array<{ line: number; org: string }> {
  const found: Array<{ line: number; org: string }> = [];
  text.split(/\r?\n/).forEach((content, index) => {
    for (const pattern of ADO_ORG_PATTERNS) {
      for (const match of content.matchAll(pattern)) {
        const org = match[1]!;
        if (!EXAMPLE_ADO_ORGS.has(org.toLowerCase())) found.push({ line: index + 1, org });
      }
    }
  });
  return found;
}

function listScannedFiles(rootDir: string): string[] {
  const files = SCANNED_ROOT_FILES.map((file) => join(rootDir, file)).filter((file) => existsSync(file));
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path);
      } else if (TEXT_EXTENSIONS.has(extname(entry.name))) {
        files.push(path);
      }
    }
  };
  for (const dir of SCANNED_DIRS) {
    const path = join(rootDir, dir);
    if (existsSync(path) && statSync(path).isDirectory()) walk(path);
  }
  return files;
}

/** Every problem as one printable line; an empty list means the repository passes. */
export function auditPublicRepo(rootDir: string): string[] {
  const problems: string[] = [];
  const lockfile = join(rootDir, "package-lock.json");
  if (existsSync(lockfile)) {
    const hosts = findLockfileHosts(readFileSync(lockfile, "utf8"));
    if (hosts.length > 0) {
      problems.push(
        `package-lock.json: ${hosts.length} entries are not on ${PUBLIC_NPM_HOST} (${[...new Set(hosts)].join(", ")}). Run: npm run lockfile:public`,
      );
    }
  }
  for (const file of listScannedFiles(rootDir)) {
    for (const { line, org } of findAdoOrgs(readFileSync(file, "utf8"))) {
      const path = relative(rootDir, file).replaceAll("\\", "/");
      problems.push(`${path}:${line}: Azure DevOps org "${org}" is not an example org. Use a made-up org in tests and docs.`);
    }
  }
  return problems;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  if (process.argv.includes("--fix-lockfile")) {
    const lockfile = join(REPO_ROOT, "package-lock.json");
    writeFileSync(lockfile, normalizeLockfile(readFileSync(lockfile, "utf8")));
  }
  const problems = auditPublicRepo(REPO_ROOT);
  const stream = problems.length === 0 ? process.stdout : process.stderr;
  stream.write(problems.length === 0 ? "Public repo audit passed.\n" : `${problems.join("\n")}\n`);
  if (problems.length > 0) process.exitCode = 1;
}
