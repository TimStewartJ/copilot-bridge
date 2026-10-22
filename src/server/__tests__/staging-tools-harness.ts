// Shared setup for the staging-tools test files. Their vi.mock calls route node:fs, node:child_process
// and the Bridge modules below through ./staging-tools-mocks.js, so this module sees the mocked versions.
import { afterEach, beforeEach, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import express from "express";
import {
  buildPublicUrlMock,
  captureProcessIdentityMock,
  createDirectoryLinkMock,
  dependencySyncHashMock,
  execSyncMock,
  existsSyncOverrideMock,
  isDataFilePath,
  isDeployValidationStampPath,
  isStagingDependencyHashPath,
  lstatSyncOverrideMock,
  mockDataFilePresence,
  preparePatchedPackagesForInstallMock,
  prepareReleaseSlotMock,
  readFileSyncOverrideMock,
  removeDirectoryLinkMock,
  renameSyncCallMock,
  requestRestartMock,
  rmSyncCallMock,
  rmSyncThrowDirs,
  spawnMock,
  stagingLogMock,
  terminateProcessTreeMock,
  unlinkSyncCallMock,
  writeFileSyncCallMock,
} from "./staging-tools-mocks.js";

export type ToolInvocation = {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
};

export function toolInvocation(toolName: string, ids: { sessionId?: string; toolCallId?: string } = {}): ToolInvocation {
  return { sessionId: ids.sessionId ?? "session-1", toolCallId: ids.toolCallId ?? "tool-1", toolName, arguments: {} };
}

/** Worktrees and previews are deleted directly, so the delete call is what proves a removal. */
export function removedTrees(): string[] {
  return rmSyncCallMock.mock.calls.map(([path]) => String(path));
}

const tempDirs: string[] = [];

export function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function createProductionDataDir(): string {
  const dataDir = createTempDir("bridge-stage-prod-");
  const db = new DatabaseSync(join(dataDir, "bridge.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL
    );
    INSERT INTO schedules (id, enabled) VALUES ('daily', 1);

    CREATE TABLE push_subscriptions (
      id TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      expirationTime INTEGER,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      userAgent TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      lastSeenAt TEXT NOT NULL
    );
    INSERT INTO push_subscriptions (
      id, endpoint, expirationTime, p256dh, auth, userAgent, createdAt, updatedAt, lastSeenAt
    ) VALUES (
      'sub-1',
      'https://push.example.test/send/sub-1',
      NULL,
      'p256dh',
      'auth',
      'agent',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    );

    CREATE TABLE copilot_usage_sessions (
      sessionId TEXT PRIMARY KEY,
      parserVersion INTEGER NOT NULL,
      fingerprintJson TEXT NOT NULL,
      resultJson TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    INSERT INTO copilot_usage_sessions (
      sessionId, parserVersion, fingerprintJson, resultJson, updatedAt
    ) VALUES (
      'production-session',
      1,
      '{"events":{"state":"missing"},"modelState":{"state":"missing"}}',
      '{"hasEvents":false,"included":false,"includedUsageAts":[],"skippedAt":null,"modelRows":[],"totals":{}}',
      '2026-01-01T00:00:00.000Z'
    );

    CREATE TABLE copilot_usage_scan_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      completedAt TEXT
    );
    INSERT INTO copilot_usage_scan_state (id, completedAt)
    VALUES (1, '2026-01-01T00:00:00.000Z');

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO settings (key, value) VALUES (
      'app',
      '{"model":"gpt-5.5","reasoningEffort":"xhigh","theme":"dark","customInstructions":"keep me"}'
    );

    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      config TEXT NOT NULL,
      enabledByDefault INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX idx_mcp_servers_enabledByDefault ON mcp_servers(enabledByDefault);
  `);
  db.close();

  const docsDir = join(dataDir, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "note.md"), "# docs");
  return dataDir;
}

export const PREVIEW_VALIDATION_COMMANDS = [
  "npm run check:pr",
] as const;
export const PREVIEW_GATE_COMMAND = PREVIEW_VALIDATION_COMMANDS.join(" && ");

export const DEPLOY_VALIDATION_COMMANDS = [
  "npm run check:pr",
  "npm run preview:smoke",
] as const;
export const DEPLOY_SMOKE_COMMAND = "npm run preview:smoke";
export const DEPLOY_STASH_SHA = "cafebabecafebabecafebabecafebabecafebabe";
export const STASH_LIST_COMMAND = 'git --no-pager stash list --format="%H %gs"';

export function isStashListCommand(cmd: string): boolean {
  return cmd === STASH_LIST_COMMAND;
}

export function isStashPushCommand(cmd: string): boolean {
  return cmd.startsWith('git stash push --include-untracked -m "bridge-deploy-');
}

/** The unique marker the deploy stashes production changes under. */
export function stashMarkerOf(cmd: string): string {
  return cmd.slice(cmd.indexOf('"') + 1, cmd.lastIndexOf('"'));
}

export function stagingStampJson(prefix: string, commitSha: string, dependencyHash = "same-hash"): string {
  return JSON.stringify({
    stagingPrefix: prefix,
    stagingCommitSha: commitSha,
    dependencyHash,
    gateId: "preview",
    gateVersion: 1,
    command: PREVIEW_GATE_COMMAND,
    source: "staging_preview",
    validatedAt: "2026-05-18T20:00:00.000Z",
  });
}

export function expectIsolatedValidationEnv(env: NodeJS.ProcessEnv | undefined) {
  expect(env?.BRIDGE_DATA_DIR).toBeTruthy();
  expect(env?.BRIDGE_DOCS_DIR).toBeTruthy();
  expect(env?.COPILOT_HOME).toBeTruthy();
  expect(env).toMatchObject({
    GIT_PAGER: "cat",
    PAGER: "cat",
    TERM: "dumb",
    GIT_TERMINAL_PROMPT: "0",
  });
  expect(basename(env!.BRIDGE_DATA_DIR!)).toBe("data");
  expect(basename(env!.BRIDGE_DOCS_DIR!)).toBe("docs");
  expect(basename(env!.COPILOT_HOME!)).toBe(".copilot");
  expect(dirname(env!.BRIDGE_DATA_DIR!)).toBe(dirname(env!.BRIDGE_DOCS_DIR!));
  expect(dirname(env!.BRIDGE_DATA_DIR!)).toBe(dirname(env!.COPILOT_HOME!));
}

export type LoadStagingToolsOptions = {
  previewParent?: string;
};

export async function loadStagingToolsModule(options: LoadStagingToolsOptions = {}) {
  vi.resetModules();
  vi.stubEnv("BRIDGE_STAGING_PREVIEW_DIR", options.previewParent ?? createTempDir("bridge-stage-preview-root-"));
  // staging_preview seeds from PRODUCTION_DATA_DIR when no seeder is injected.
  // Pin it to an empty temp dir so no test can snapshot a real bridge.db.
  const productionDataDir = join(createTempDir("bridge-stage-production-"), "data");
  mkdirSync(productionDataDir, { recursive: true });
  vi.stubEnv("BRIDGE_DATA_DIR", productionDataDir);
  return import("../staging-tools.js");
}

export async function loadStagingTools(options: LoadStagingToolsOptions = {}) {
  const mod = await loadStagingToolsModule(options);
  return Object.fromEntries(mod.STAGING_TOOLS.map((tool: any) => [tool.name, tool])) as Record<string, any>;
}

export type StagingToolsModule = Awaited<ReturnType<typeof loadStagingToolsModule>>;

export function createStagingPreviewTestApp(mod: StagingToolsModule) {
  const app = express();
  mod.registerExpressApp(app);

  app.use("/staging/:prefix/api", (req, res, next) => {
    const router = mod.getStagingRouter(req.params.prefix);
    if (router) {
      router(req, res, next);
    } else {
      next();
    }
  });

  app.use("/staging/:prefix", (req, res) => {
    const distDir = mod.getActivePreviews().get(req.params.prefix);
    if (!distDir || !existsSync(distDir)) {
      return res.status(404).send("Staging preview not found.");
    }
    express.static(distDir)(req, res, () => {
      res.sendFile(join(distDir, "index.html"));
    });
  });

  return app;
}

export function publishTestPreviewGeneration(
  mod: StagingToolsModule,
  stagingDir: string,
  generationId: string,
  html: string,
  previewParent?: string,
) {
  const target = mod.__testing.createPreviewGenerationTarget(
    stagingDir,
    generationId,
    previewParent,
  );
  mkdirSync(target.outDir, { recursive: true });
  mkdirSync(target.dataDir!, { recursive: true });
  writeFileSync(join(target.outDir, "index.html"), html);
  writeFileSync(join(target.dataDir!, "bridge.db"), "test database");
  mod.__testing.publishPreviewGeneration(target, previewParent);
  return target;
}

export function successfulCommandOutput(command: string): string {
  const viteOutDir = command.match(/\bnpx vite build\b.*--outDir "([^"]+)"/)?.[1];
  if (viteOutDir) {
    mkdirSync(viteOutDir, { recursive: true });
    writeFileSync(join(viteOutDir, "index.html"), "<!doctype html>");
  }
  return "";
}

/** Registers the per-test reset of every staging-tools mock. Call once at the top of each test file. */
export function useStagingToolsTestEnvironment(): void {
  beforeEach(() => {
    // Validation log writes are intercepted through the node:fs mock above, but the
    // retention sweep they trigger uses node:fs/promises. Point every writer and
    // sweep at a temp directory so no test can touch the real validation log dir.
    vi.stubEnv(
      "BRIDGE_VALIDATION_LOG_DIR",
      join(createTempDir("bridge-staging-validation-"), "data", "validation-logs"),
    );
    lstatSyncOverrideMock.mockImplementation((path) =>
      basename(String(path)) === "node_modules"
        ? { isSymbolicLink: () => false, isDirectory: () => true }
        : undefined);
    readFileSyncOverrideMock.mockImplementation((path) =>
      isStagingDependencyHashPath(String(path)) ? "same-hash\n" : undefined);
    execSyncMock.mockImplementation(successfulCommandOutput);
  });

  afterEach(() => {
    rmSyncThrowDirs.clear();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
    requestRestartMock.mockReset();
    dependencySyncHashMock.mockReset();
    dependencySyncHashMock.mockReturnValue("same-hash");
    prepareReleaseSlotMock.mockClear();
    existsSyncOverrideMock.mockReset();
    mockDataFilePresence();
    preparePatchedPackagesForInstallMock.mockReset();
    preparePatchedPackagesForInstallMock.mockReturnValue({
      packages: [],
      discard: vi.fn(),
      restore: vi.fn(),
    });
    createDirectoryLinkMock.mockReset();
    createDirectoryLinkMock.mockReturnValue({ ok: true, output: "" });
    removeDirectoryLinkMock.mockReset();
    removeDirectoryLinkMock.mockReturnValue({ ok: true, output: "" });
    lstatSyncOverrideMock.mockReset();
    buildPublicUrlMock.mockReset();
    buildPublicUrlMock.mockReturnValue(undefined);
    execSyncMock.mockReset();
    execSyncMock.mockImplementation(successfulCommandOutput);
    spawnMock.mockReset();
    captureProcessIdentityMock.mockClear();
    terminateProcessTreeMock.mockClear();
    writeFileSyncCallMock.mockReset();
    readFileSyncOverrideMock.mockReset();
    unlinkSyncCallMock.mockReset();
    rmSyncCallMock.mockReset();
    renameSyncCallMock.mockReset();
    stagingLogMock.mockReset();
    vi.resetModules();
  });
}

/** The commit a deploy scenario validates, merges and pushes unless a test answers differently. */
export const VALIDATED_SHA = "1111111111111111111111111111111111111111";

export interface DeployGitState {
  /** The marker this deploy stashed production changes under, once it has stashed them. */
  stashMarker: string;
}

/**
 * Answers one command before the declared happy path does: return the output, throw (see failCommand)
 * to fail it, or return undefined to leave it to the happy path.
 */
export type DeployCommandOverride = (cmd: string, cwd: string | undefined, git: DeployGitState) => string | undefined;

export function failCommand(message: string, stderr: string): never {
  throw Object.assign(new Error(message), { stderr });
}

/** The stages of a clean deploy, in order. A scenario allows the commands of the stages up to its `through`. */
export const DEPLOY_STAGES = ["commit", "stash", "rebase", "validate", "merge", "push", "cleanup"] as const;
export type DeployStage = (typeof DEPLOY_STAGES)[number];

type HappyPathAnswer = (cmd: string, cwd: string | undefined) => string | undefined;

function deployHappyPath(stagingDir: string, branch: string, git: DeployGitState, stashChanges: boolean) {
  const stages: Record<DeployStage, HappyPathAnswer> = {
    commit: (cmd) => (cmd === "git add -A" || cmd === "git --no-pager status --porcelain" ? "" : undefined),
    stash: (cmd) => {
      if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
      if (cmd === `git log main..${branch} --oneline`) return "abc123 deploy commit\n";
      if (isStashListCommand(cmd)) return git.stashMarker ? `${DEPLOY_STASH_SHA} On main: ${git.stashMarker}\n` : "";
      if (!isStashPushCommand(cmd)) return undefined;
      if (!stashChanges) return "No local changes to save\n";
      git.stashMarker = stashMarkerOf(cmd);
      return `Saved working directory and index state On main: ${git.stashMarker}\n`;
    },
    rebase: (cmd, cwd) => {
      if (cmd === "git pull --rebase origin main") return "Already up to date.\n";
      return cmd === "git rebase main" && cwd === stagingDir ? "" : undefined;
    },
    validate: (cmd, cwd) => {
      if ((DEPLOY_VALIDATION_COMMANDS as readonly string[]).includes(cmd)) return "";
      return cmd === "git rev-parse HEAD" && cwd === stagingDir ? `${VALIDATED_SHA}\n` : undefined;
    },
    merge: (cmd) => {
      if (cmd === "git rev-parse HEAD") return `${VALIDATED_SHA}\n`;
      if (cmd === `git merge "${branch}" --no-edit`) return "";
      return cmd === "git rev-parse --short HEAD" ? "1111111\n" : undefined;
    },
    push: (cmd) => (cmd === "git push origin main" ? "" : undefined),
    cleanup: (cmd) => {
      if (cmd.startsWith("git branch --list ")) return `${branch}\n`;
      return cmd === "git worktree prune" || cmd === `git branch -D -- ${branch}` ? "" : undefined;
    },
  };
  return stages;
}

/**
 * Makes the mocked command runner behave like a production checkout on main that a staging worktree
 * deploys into cleanly, as far as the stage `through`. Any other command throws, so a deploy that runs
 * a command the test did not expect fails. With `stashChanges`, production has uncommitted changes, so
 * the deploy stashes them and the stash list shows that entry. Restoring the stash (`git stash pop`) is
 * never on the happy path: a test that expects it answers it in `respond`.
 */
export function mockDeployCommands(
  stagingDir: string,
  options: { stashChanges?: boolean; through?: DeployStage; respond?: DeployCommandOverride } = {},
): DeployGitState {
  const branch = `staging/${basename(stagingDir)}`;
  const git: DeployGitState = { stashMarker: "" };
  const stages = deployHappyPath(stagingDir, branch, git, options.stashChanges ?? false);
  const allowed = DEPLOY_STAGES.slice(0, DEPLOY_STAGES.indexOf(options.through ?? "cleanup") + 1).map((stage) => stages[stage]);
  execSyncMock.mockImplementation((cmd: string, commandOptions?: { cwd?: string }) => {
    const cwd = commandOptions?.cwd;
    const override = options.respond?.(cmd, cwd, git);
    if (override !== undefined) return override;
    for (const answer of allowed) {
      const output = answer(cmd, cwd);
      if (output !== undefined) return output;
    }
    throw new Error(`Unexpected command: ${cmd} (cwd: ${cwd ?? "unknown"})`);
  });
  return git;
}

/** A staging worktree ready to deploy, with the mocked commands of `mockDeployCommands`. */
export async function setupDeployScenario(options: {
  name?: string;
  stashChanges?: boolean;
  through?: DeployStage;
  respond?: DeployCommandOverride;
} = {}) {
  const mod = await loadStagingToolsModule();
  const deployTool = mod.STAGING_TOOLS.find((tool: { name: string }) => tool.name === "staging_deploy") as any;
  if (!deployTool) throw new Error("staging_deploy tool not found");
  const stagingDir = join(createTempDir("bridge-stage-parent-"), options.name ?? "preview-deploy");
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(join(stagingDir, ".gitignore"), "node_modules\n");
  const git = mockDeployCommands(stagingDir, options);
  return {
    mod,
    stagingDir,
    git,
    deploy: (message: string, ids?: { sessionId?: string; toolCallId?: string }): Promise<any> =>
      deployTool.handler({ stagingDir, message }, toolInvocation("staging_deploy", ids)),
  };
}
export function executedCommands(): string[] {
  return execSyncMock.mock.calls.map(([cmd]) => String(cmd));
}

export function wroteDataFile(filename: string): boolean {
  return writeFileSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), filename));
}

export function unlinkedDataFile(filename: string): boolean {
  return unlinkSyncCallMock.mock.calls.some(([file]) => isDataFilePath(String(file), filename));
}

export function publishedDeployValidationStamp(): boolean {
  return renameSyncCallMock.mock.calls.some(([, file]) => isDeployValidationStampPath(String(file)));
}

/** Makes production report an existing rollback checkpoint from an earlier deploy. */
export function mockExistingRollbackCheckpoint(): void {
  mockDataFilePresence({ preDeploySha: true });
  readFileSyncOverrideMock.mockImplementation((path) =>
    isStagingDependencyHashPath(String(path))
      ? "same-hash\n"
      : isDataFilePath(String(path), "pre-deploy-sha") ? "preserved-checkpoint\n" : undefined,
  );
}