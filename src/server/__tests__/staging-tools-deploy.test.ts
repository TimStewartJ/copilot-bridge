import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  DEPLOY_SMOKE_COMMAND,
  DEPLOY_STASH_SHA,
  DEPLOY_VALIDATION_COMMANDS,
  STASH_LIST_COMMAND,
  VALIDATED_SHA,
  executedCommands,
  expectIsolatedValidationEnv,
  failCommand,
  isStashListCommand,
  isStashPushCommand,
  mockExistingRollbackCheckpoint,
  publishTestPreviewGeneration,
  publishedDeployValidationStamp,
  removedTrees,
  setupDeployScenario,
  stagingStampJson,
  unlinkedDataFile,
  useStagingToolsTestEnvironment,
  wroteDataFile,
} from "./staging-tools-harness.js";
import {
  dependencySyncHashMock,
  execSyncMock,
  existsSyncOverrideMock,
  hasRestartSignalWriteAttempt,
  isDataFilePath,
  isDeployValidationStampPath,
  isRestartSignalTempPath,
  isStagingDependencyHashPath,
  isStagingValidationStampPath,
  mockDataFilePresence,
  preparePatchedPackagesForInstallMock,
  prepareReleaseSlotMock,
  readFileSyncOverrideMock,
  requestRestartMock,
  rmSyncThrowDirs,
  spawnMock,
  stagingLogMock,
  unlinkSyncCallMock,
  writeFileSyncCallMock,
  type MockSpawnOptions,
} from "./staging-tools-mocks.js";

const mocks = await vi.hoisted(() => import("./staging-tools-mocks.js"));
vi.mock("@github/copilot-sdk", () => mocks.copilotSdkModule);
vi.mock("node:child_process", async (importOriginal) => mocks.mockChildProcess(await importOriginal()));
vi.mock("node:fs", async (importOriginal) => mocks.mockNodeFs(await importOriginal()));
vi.mock("../restart-signal.js", async (importOriginal) => mocks.mockRestartSignal(await importOriginal()));
vi.mock("../dependency-sync.js", () => mocks.dependencySyncModule);
vi.mock("../release-slots.js", () => mocks.releaseSlotsModule);
vi.mock("../platform.js", () => mocks.platformModule);
vi.mock("../public-url.js", () => mocks.publicUrlModule);
vi.mock("../config.js", () => mocks.configModule);
vi.mock("../staging-log.js", () => mocks.stagingLogModule);

useStagingToolsTestEnvironment();

const PRODUCTION_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const deployGateFails = (cmd: string) =>
  cmd === "npm run check:pr" ? failCommand("deploy gate failed", "deploy gate exploded\n") : undefined;
const stashPopConflicts = (file: string) => (cmd: string) =>
  cmd === "git stash pop"
    ? failCommand("git stash pop failed", `CONFLICT (content): Merge conflict in ${file}\n`)
    : undefined;

describe("staging_deploy", () => {
  it("queues a restart without diffing or syncing production dependencies in-process", async () => {
    const { deploy } = await setupDeployScenario();

    const result = await deploy("Deploy dependency change");

    expect(result).toMatchObject({ success: true, commitSha: "1111111" });
    expect(requestRestartMock).toHaveBeenCalledTimes(1);
    expect(preparePatchedPackagesForInstallMock).not.toHaveBeenCalled();
    expect(dependencySyncHashMock).toHaveBeenCalledTimes(2);
    const commands = executedCommands();
    expect(commands).not.toContain("npm install --no-audit --no-fund --include=dev");
    expect(commands.some((cmd) => cmd.startsWith("git diff "))).toBe(false);
    expect(spawnMock).toHaveBeenCalledWith(
      "git",
      ["pull", "--rebase", "origin", "main"],
      expect.objectContaining({ shell: false }),
    );
    expect(wroteDataFile("pre-deploy-sha")).toBe(true);
    expect(publishedDeployValidationStamp()).toBe(true);
    expect(wroteDataFile("deps-hash")).toBe(false);
  });

  it("withdraws the preview at deploy time and deletes it with the worktree only after activation", async () => {
    const { mod, stagingDir } = await setupDeployScenario();
    const preview = publishTestPreviewGeneration(mod, stagingDir, "generation-one", "<!doctype html>");
    const previewsServedByAStartingServer = () => {
      const served = new Map<string, string>();
      mod.registerExistingPreviewsFromDisk({ stagingParent: dirname(stagingDir), activePreviewMap: served, expressApp: null });
      return [...served.keys()];
    };
    expect(previewsServedByAStartingServer()).toEqual([preview.prefix]);
    // A deploy-batch update must continue while the launcher waits for the
    // existing restart to reach cutover.
    mockDataFilePresence({ restartInProgress: true });

    const result = await mod.runStagingDeployJob(
      { stagingDir, message: "batch" },
      { deferDeployRestart: true },
    ) as any;

    expect(result).toMatchObject({
      success: true,
      restartDeferred: true,
      releaseCandidate: { commitSha: VALIDATED_SHA },
    });
    expect(requestRestartMock).not.toHaveBeenCalled();

    // The restarted server warms the newest published preview and then holds its database open,
    // so the preview is withdrawn now. Nothing is deleted before the release is activated.
    expect(previewsServedByAStartingServer()).toEqual([]);
    expect(existsSync(join(preview.dataDir!, "bridge.db"))).toBe(true);
    expect(removedTrees()).not.toContain(stagingDir);

    await mod.cleanupCompletedStagingDeploy(stagingDir);

    expect(existsSync(preview.dataDir!)).toBe(false);
    expect(removedTrees()).toContain(stagingDir);
    expect(existsSync(stagingDir)).toBe(false);
    expect(executedCommands().slice(-3)).toEqual([
      "git worktree prune",
      "git branch --list --format=%(refname:short) -- staging/preview-deploy",
      "git branch -D -- staging/preview-deploy",
    ]);
  });

  it("leaves the worktree alone while the deployed preview cannot be deleted", async () => {
    const { mod, stagingDir } = await setupDeployScenario();
    const preview = publishTestPreviewGeneration(mod, stagingDir, "generation-one", "<!doctype html>");
    // A backend that holds the preview database open fails the delete (EPERM on Windows), and
    // that backend runs out of the worktree. Deleting half of it would break a live process.
    rmSyncThrowDirs.add(dirname(dirname(preview.outDir)));

    await expect(mod.cleanupCompletedStagingDeploy(stagingDir)).rejects.toThrow("EBUSY");

    expect(removedTrees()).not.toContain(stagingDir);
    expect(executedCommands()).not.toContain('git branch -D -- staging/preview-deploy');
  });

  it("uses a matching preview validation stamp to run smoke-only deploy validation", async () => {
    let productionHeadCalls = 0;
    const { deploy } = await setupDeployScenario({
      respond: (cmd, cwd) => {
        if (cmd === DEPLOY_SMOKE_COMMAND) return "smoke ok\n";
        if (cmd === "npm run check:deploy") throw new Error("full deploy gate should be skipped");
        if (cmd === "git rev-parse HEAD" && !cwd?.endsWith("preview-deploy")) {
          return ++productionHeadCalls === 1 ? `${PRODUCTION_HEAD}\n` : undefined;
        }
        return undefined;
      },
    });
    existsSyncOverrideMock.mockImplementation((path) => {
      const normalized = String(path);
      if (isStagingValidationStampPath(normalized)) return true;
      if (isDataFilePath(normalized, "restart.signal")) return false;
      if (isDataFilePath(normalized, "restart-in-progress.json")) return false;
      if (isDataFilePath(normalized, "pre-deploy-sha")) return false;
      return undefined;
    });
    readFileSyncOverrideMock.mockImplementation((path) =>
      isStagingDependencyHashPath(String(path))
        ? "same-hash\n"
        : isStagingValidationStampPath(String(path))
        ? stagingStampJson("preview-deploy", VALIDATED_SHA)
        : undefined,
    );

    const result = await deploy("Deploy with preview stamp");

    expect(result).toMatchObject({ success: true, commitSha: "1111111" });
    const commands = executedCommands();
    expect(commands).toContain(DEPLOY_SMOKE_COMMAND);
    expect(commands).not.toContain("npm run check:deploy");
    expect(publishedDeployValidationStamp()).toBe(true);
    const deployStampWrite = writeFileSyncCallMock.mock.calls.find(([file]) => isDeployValidationStampPath(String(file)));
    expect(String(deployStampWrite?.[1])).toContain('"command": "npm run check:deploy"');
  });

  it("unstashes and blocks merge when the prepared release candidate differs from the validated commit", async () => {
    const releaseCandidateSha = "2222222222222222222222222222222222222222";
    prepareReleaseSlotMock.mockImplementationOnce(async (options) => ({
      ok: true as const,
      manifest: {
        version: 1,
        id: "release-slot-mismatched",
        root: join(options.dataDir, "release-slots", "release-slot-mismatched"),
        commitSha: releaseCandidateSha,
        source: options.source,
        dependencyHash: "same-hash",
        createdAt: "2026-05-18T20:00:00.000Z",
        validationMode: options.validationMode,
      },
    }));
    const { stagingDir, deploy } = await setupDeployScenario({
      stashChanges: true,
      through: "validate",
      respond: (cmd) => (cmd === "git stash pop" ? "" : undefined),
    });

    const result = await deploy("Deploy mismatched release candidate");

    expect(result).toMatchObject({ resultType: "failure" });
    expect(result.textResultForLlm).toContain("Release candidate does not match the validated staging commit.");
    expect(result.textResultForLlm).toContain(VALIDATED_SHA);
    expect(result.textResultForLlm).toContain(releaseCandidateSha);
    expect(result.textResultForLlm).toContain("Production was not merged and restart signaling was blocked.");
    expect(result.textResultForLlm).toContain("staging worktree is still intact for retry-after-fix");
    expect(result.toolTelemetry).toEqual({
      bridge: {
        stagingDir,
        branch: "staging/preview-deploy",
        prodBranch: "main",
        validatedCommitSha: VALIDATED_SHA,
        releaseCandidateSha,
      },
    });
    expect(prepareReleaseSlotMock).toHaveBeenCalledTimes(1);
    expect(prepareReleaseSlotMock).toHaveBeenCalledWith(expect.objectContaining({ commitSha: VALIDATED_SHA }));

    const commands = executedCommands();
    const stashIndex = commands.findIndex(isStashPushCommand);
    const unstashIndex = commands.indexOf("git stash pop");
    expect(stashIndex).toBeGreaterThan(-1);
    expect(unstashIndex).toBeGreaterThan(stashIndex);
    expect(execSyncMock.mock.calls[unstashIndex]?.[1]?.cwd).toBe(execSyncMock.mock.calls[stashIndex]?.[1]?.cwd);
    const headReads = execSyncMock.mock.calls.filter(([cmd]) => String(cmd) === "git rev-parse HEAD");
    expect(headReads).toHaveLength(1);
    expect(headReads[0]?.[1]?.cwd).toBe(stagingDir);
    expect(commands).not.toContain('git merge "staging/preview-deploy" --no-edit');
    expect(commands).not.toContain("git push origin main");
    expect(removedTrees()).not.toContain(stagingDir);
    expect(commands).not.toContain('git branch -D -- staging/preview-deploy');
    expect(commands).not.toContain("git worktree prune");
    expect(requestRestartMock).not.toHaveBeenCalled();
    expect(hasRestartSignalWriteAttempt()).toBe(false);
    expect(wroteDataFile("pre-deploy-sha")).toBe(false);
    expect(publishedDeployValidationStamp()).toBe(false);
    expect(existsSync(stagingDir)).toBe(true);
    expect(readFileSync(join(stagingDir, ".gitignore"), "utf-8")).toBe("node_modules\n");
  });

  it.each([
    {
      command: "git add -A",
      stderr: "fatal: Unable to create '.git/index.lock': File exists.\n",
      message: "Failed to stage staging worktree changes for the deploy commit.",
      detail: "index.lock",
      ran: ["git add -A"],
    },
    {
      command: "git --no-pager status --porcelain",
      stderr: "fatal: not a git repository\n",
      message: "Failed to read the staging worktree status.",
      detail: "not a git repository",
      ran: ["git add -A", "git --no-pager status --porcelain"],
    },
  ])("fails the deploy before committing when `$command` fails", async ({ command, stderr, message, detail, ran }) => {
    const { stagingDir, deploy } = await setupDeployScenario({
      through: "commit",
      respond: (cmd) => (cmd === command ? failCommand(`${command} failed`, stderr) : undefined),
    });

    const result = await deploy("Deploy with a broken worktree");

    expect(result).toMatchObject({
      resultType: "failure",
      sessionLog: expect.stringContaining(`Command: ${command}`),
      toolTelemetry: { bridge: { command, cwd: stagingDir, stagingDir, branch: "staging/preview-deploy" } },
    });
    expect(result.textResultForLlm).toContain(message);
    expect(result.textResultForLlm).toContain(detail);
    expect(executedCommands()).toEqual(ran);
    expect(writeFileSyncCallMock.mock.calls.some(([file]) => basename(String(file)) === ".commit-msg")).toBe(false);
    expect(requestRestartMock).not.toHaveBeenCalled();
  });

  describe("production stash", () => {
    it("stops the deploy when stashing uncommitted production changes fails", async () => {
      const { deploy } = await setupDeployScenario({
        through: "stash",
        respond: (cmd) => (isStashPushCommand(cmd)
          ? failCommand("git stash failed", "error: cannot save the current index state\n")
          : undefined),
      });

      const result = await deploy("Deploy with an unstashable production tree");

      expect(result).toMatchObject({
        resultType: "failure",
        sessionLog: expect.stringContaining("Command: git stash push --include-untracked -m "),
      });
      expect(result.textResultForLlm).toContain("Failed to stash uncommitted production changes.");
      expect(result.textResultForLlm).toContain("cannot save the current index state");
      expect(result.stashRestoreFailed).toBeUndefined();
      const commands = executedCommands();
      expect(commands).not.toContain("git stash pop");
      expect(commands).not.toContain("git pull --rebase origin main");
      expect(commands).not.toContain("git rebase main");
      expect(commands).not.toContain('git merge "staging/preview-deploy" --no-edit');
      expect(commands).not.toContain("git push origin main");
      expect(requestRestartMock).not.toHaveBeenCalled();
    });

    it("warns that production changes are still stashed when the post-deploy stash pop fails", async () => {
      const { deploy } = await setupDeployScenario({
        stashChanges: true,
        respond: stashPopConflicts("src/server/api-router.ts"),
      });

      const result = await deploy("Deploy with a conflicting production stash");

      expect(result).toMatchObject({ success: true, commitSha: "1111111", stashRestoreFailed: true });
      expect(result.stashRecoveryWarning).toContain("still saved in git stash");
      expect(result.stashRecoveryWarning).toContain("git stash list");
      expect(result.stashRecoveryWarning).toContain("git stash pop");
      expect(result.stashRecoveryWarning).toContain("Merge conflict in src/server/api-router.ts");
      expect(result.message).toContain("still saved in git stash");
      expect(result.content?.[0]?.text).toContain("still saved in git stash");
      expect(result.content?.[0]?.text).toContain("git stash list");
      expect(result.summary).toContain("could not be restored automatically");
      expect(stagingLogMock.mock.calls.map(([msg]) => String(msg))).not.toContain("Restored stashed production changes");
      expect(executedCommands().filter((cmd) => cmd === "git stash pop")).toHaveLength(1);
      expect(requestRestartMock).toHaveBeenCalledTimes(1);
    });

    it("warns about the stranded production stash on deploy failure paths", async () => {
      const popConflicts = stashPopConflicts("src/server/db.ts");
      const { deploy } = await setupDeployScenario({
        stashChanges: true,
        through: "validate",
        respond: (cmd) => popConflicts(cmd) ?? deployGateFails(cmd),
      });

      const result = await deploy("Deploy that fails validation");

      expect(result).toMatchObject({ resultType: "failure", stashRestoreFailed: true });
      expect(result.textResultForLlm).toContain("Staging deploy validation failed.");
      expect(result.textResultForLlm).toContain("still saved in git stash");
      expect(result.sessionLog).toContain("still saved in git stash");
      expect(executedCommands().filter((cmd) => cmd === "git stash pop")).toHaveLength(1);
      expect(requestRestartMock).not.toHaveBeenCalled();
    });

    it("leaves production changes stashed when the post-push reset also fails", async () => {
      const { git, deploy } = await setupDeployScenario({
        stashChanges: true,
        through: "push",
        respond: (cmd) => {
          if (cmd === "git push origin main") failCommand("push failed", "push rejected\n");
          if (cmd === `git reset --hard ${VALIDATED_SHA}`) failCommand("reset failed", "fatal: Unable to write new index file\n");
          return undefined;
        },
      });

      const result = await deploy("Deploy that cannot be reverted");

      expect(result).toMatchObject({ resultType: "failure" });
      expect(result.stashRestoreFailed).toBeUndefined();
      expect(result.textResultForLlm).toContain("Push to origin failed and production reset failed.");
      expect(result.textResultForLlm).toContain(`Your uncommitted production changes are stashed as '${git.stashMarker}'`);
      expect(result.textResultForLlm).toContain("restore them only after recovering the checkout");
      expect(executedCommands()).not.toContain("git stash pop");
      expect(requestRestartMock).not.toHaveBeenCalled();
    });

    it("leaves the deploy stash in place when another stash entry lands on top", async () => {
      const concurrentStashSha = "0123456789012345678901234567890123456789";
      let stashListCalls = 0;
      const { deploy } = await setupDeployScenario({
        stashChanges: true,
        respond: (cmd, _cwd, git) => {
          if (!isStashListCommand(cmd)) return undefined;
          // Someone else stashes in the production checkout during the deploy
          // window, so this deploy's entry is no longer on top by restore time.
          return ++stashListCalls === 1
            ? `${DEPLOY_STASH_SHA} On main: ${git.stashMarker}\n`
            : `${concurrentStashSha} On main: someone else\n${DEPLOY_STASH_SHA} On main: ${git.stashMarker}\n`;
        },
      });

      const result = await deploy("Deploy racing a concurrent stash");

      expect(result).toMatchObject({ success: true, commitSha: "1111111", stashRestoreFailed: true });
      expect(result.stashRecoveryWarning).toContain(DEPLOY_STASH_SHA);
      expect(result.stashRecoveryWarning).toContain("no longer the entry");
      expect(result.stashRecoveryWarning).toContain(concurrentStashSha);
      expect(result.content?.[0]?.text).toContain("still saved in git stash");
      expect(executedCommands()).not.toContain("git stash pop");
      expect(requestRestartMock).toHaveBeenCalledTimes(1);
    });

    it("keeps the deploy stash untouched when the stash list cannot be read after stashing", async () => {
      const { git, deploy } = await setupDeployScenario({
        stashChanges: true,
        through: "validate",
        respond: (cmd) => (isStashListCommand(cmd)
          ? failCommand("git stash list failed", "fatal: bad object refs/stash\n")
          : deployGateFails(cmd)),
      });

      const result = await deploy("Deploy with an unreadable stash list");

      expect(result).toMatchObject({ resultType: "failure", stashRestoreFailed: true });
      expect(result.textResultForLlm).toContain("Staging deploy validation failed.");
      expect(result.stashRecoveryWarning).toContain("could not be read after stashing");
      expect(result.stashRecoveryWarning).toContain(git.stashMarker);
      expect(result.stashRecoveryWarning).toContain("bad object refs/stash");
      expect(executedCommands()).not.toContain("git stash pop");
      expect(requestRestartMock).not.toHaveBeenCalled();
    });

    it("reports the stranded stash when the stash list read throws after stashing", async () => {
      // The command runner itself blows up (not a non-zero exit) right after the
      // stash was created, so the deploy never learns what it stashed.
      stagingLogMock.mockImplementation((message: string) => {
        if (String(message).includes(`$ ${STASH_LIST_COMMAND}`)) throw new Error("log sink exploded");
      });
      const { git, deploy } = await setupDeployScenario({ stashChanges: true, through: "stash" });

      await expect(deploy("Deploy whose stash list read throws"))
        .rejects.toThrow(/log sink exploded[\s\S]*may be stashed under the message/);

      expect(git.stashMarker).not.toBe("");
      expect(executedCommands()).not.toContain("git stash pop");
      expect(requestRestartMock).not.toHaveBeenCalled();
    });

    it("surfaces the stranded stash when the deploy throws after stashing production", async () => {
      prepareReleaseSlotMock.mockImplementationOnce(async () => {
        throw new Error("release slot exploded");
      });
      const { deploy } = await setupDeployScenario({
        stashChanges: true,
        through: "validate",
        respond: stashPopConflicts("src/server/db.ts"),
      });

      await expect(deploy("Deploy that throws mid-flight"))
        .rejects.toThrow(/release slot exploded[\s\S]*still saved in git stash/);

      expect(executedCommands().filter((cmd) => cmd === "git stash pop")).toHaveLength(1);
      expect(requestRestartMock).not.toHaveBeenCalled();
    });

    it("keeps a completed deploy successful when restoring the stash throws", async () => {
      // The restore command runner itself blows up (e.g. spawn failure), which is
      // the only way left for the stash restore to throw.
      const defaultSpawn = spawnMock.getMockImplementation();
      spawnMock.mockImplementation((cmd: string, options?: any) => {
        if (cmd === "git stash pop") throw new Error("spawn exploded");
        return defaultSpawn!(cmd, options);
      });
      const { deploy } = await setupDeployScenario({ stashChanges: true });

      const result = await deploy("Deploy whose stash restore throws");

      expect(result).toMatchObject({ success: true, commitSha: "1111111", stashRestoreFailed: true });
      expect(result.stashRecoveryWarning).toContain("threw an unexpected error");
      expect(result.stashRecoveryWarning).toContain("spawn exploded");
      expect(result.content?.[0]?.text).toContain("still saved in git stash");
      expect(requestRestartMock).toHaveBeenCalledTimes(1);
    });
  });

  it("resets production and blocks push when the merged commit differs from the validated candidate", async () => {
    const { deploy } = await setupDeployScenario({
      through: "merge",
      respond: (cmd, cwd) => {
        if (cmd === "git rev-parse HEAD" && !cwd?.endsWith("preview-deploy")) return `${PRODUCTION_HEAD}\n`;
        if (cmd === "git rev-parse --short HEAD") return "2222222\n";
        if (cmd === `git reset --hard ${PRODUCTION_HEAD}`) return "";
        return undefined;
      },
    });

    const result = await deploy("Deploy raced commit");

    expect(result).toMatchObject({ resultType: "failure" });
    expect(result.textResultForLlm).toContain("Production commit changed after validation; restart blocked.");
    expect(result.textResultForLlm).toContain(`reset to ${PRODUCTION_HEAD}`);
    const commands = executedCommands();
    expect(commands).toContain(`git reset --hard ${PRODUCTION_HEAD}`);
    expect(commands).not.toContain("git push origin main");
    expect(requestRestartMock).not.toHaveBeenCalled();
    expect(hasRestartSignalWriteAttempt()).toBe(false);
  });

  it("blocks restart if pushed production HEAD differs from the validated release candidate", async () => {
    let productionHeadCalls = 0;
    const { stagingDir, deploy } = await setupDeployScenario({
      respond: (cmd, cwd) => {
        if (cmd !== "git rev-parse HEAD" || cwd?.endsWith("preview-deploy")) return undefined;
        return ++productionHeadCalls === 1 ? `${PRODUCTION_HEAD}\n` : "2222222222222222222222222222222222222222\n";
      },
    });

    const result = await deploy("Deploy dependency change");

    expect(result).toMatchObject({ resultType: "failure" });
    expect(result.textResultForLlm).toContain("Pushed production commit does not match the validated release candidate.");
    expect(result.textResultForLlm).toContain("Restart signaling was blocked");
    expect(publishedDeployValidationStamp()).toBe(false);
    expect(requestRestartMock).not.toHaveBeenCalled();
    expect(hasRestartSignalWriteAttempt()).toBe(false);
    expect(removedTrees()).not.toContain(stagingDir);
  });

  it("blocks restart when deploy validation fails on the rebased staging tree", async () => {
    const { stagingDir, deploy } = await setupDeployScenario({ through: "validate", respond: deployGateFails });

    const result = await deploy("Deploy dependency change");

    expect(result).toMatchObject({
      resultType: "failure",
      sessionLog: expect.stringContaining("Command: npm run check:pr"),
      toolTelemetry: {
        bridge: {
          command: "npm run check:pr",
          cwd: stagingDir,
          stagingDir,
          prodBranch: "main",
          validationLogPath: expect.stringContaining("validation-logs"),
        },
      },
    });
    expect(result.textResultForLlm).toContain("Staging deploy validation failed.");
    expect(result.textResultForLlm).toContain("deploy validation gate");
    expect(result.textResultForLlm).toContain("retry-after-fix");
    expect(result.textResultForLlm).toContain("deploy gate exploded");
    expect(wroteDataFile("pre-deploy-sha")).toBe(false);
    expect(hasRestartSignalWriteAttempt()).toBe(false);
    expect(requestRestartMock).not.toHaveBeenCalled();
    expect(executedCommands()).not.toContain('git merge "staging/preview-deploy" --no-edit');
  });

  it("blocks restart when pushing the merged production branch fails, without rebasing the validated commit", async () => {
    let pullAttempts = 0;
    let pushAttempts = 0;
    const { stagingDir, deploy } = await setupDeployScenario({
      through: "push",
      respond: (cmd) => {
        if (cmd === "git pull --rebase origin main") pullAttempts += 1;
        if (cmd === "git push origin main") failCommand("push failed", `push rejected ${++pushAttempts}\n`);
        if (cmd === `git reset --hard ${VALIDATED_SHA}`) return "";
        return undefined;
      },
    });

    const result = await deploy("Deploy dependency change");

    expect(result).toMatchObject({
      resultType: "failure",
      sessionLog: expect.stringContaining("Command: git push origin main"),
      toolTelemetry: {
        bridge: {
          command: "git push origin main",
          stagingDir,
          prodBranch: "main",
          commitSha: "1111111",
          revertedTo: VALIDATED_SHA,
          validationLogPath: expect.stringContaining("validation-logs"),
        },
      },
    });
    expect(result.textResultForLlm).toContain("Push to origin failed; production merge reverted and restart blocked.");
    expect(result.textResultForLlm).toContain(`reset back to ${VALIDATED_SHA}`);
    expect(result.textResultForLlm).toContain("push rejected 2");
    expect(pushAttempts).toBe(2);
    // A rejected push is retried as is: the validated commit is never pulled onto or rebased.
    expect(pullAttempts).toBe(1);
    expect(executedCommands()).not.toContain("git rebase --abort");
    expect(requestRestartMock).not.toHaveBeenCalled();
    expect(hasRestartSignalWriteAttempt()).toBe(false);
    expect(wroteDataFile("pre-deploy-sha")).toBe(true);
    expect(unlinkedDataFile("pre-deploy-sha")).toBe(true);
    expect(executedCommands()).toContain(`git reset --hard ${VALIDATED_SHA}`);
    expect(removedTrees()).not.toContain(stagingDir);
  });

  it("preserves an existing rollback checkpoint during deploy", async () => {
    mockExistingRollbackCheckpoint();
    const { deploy } = await setupDeployScenario();

    await deploy("Deploy dependency change");

    expect(wroteDataFile("pre-deploy-sha")).toBe(false);
    expect(unlinkedDataFile("pre-deploy-sha")).toBe(false);
  });

  it("only removes rollback checkpoints created by the current deploy attempt", async () => {
    const { deploy } = await setupDeployScenario({
      through: "merge",
      respond: (cmd) => {
        if (cmd === 'git merge "staging/preview-deploy" --no-edit') throw new Error("merge failed");
        if (cmd === "git merge --abort") return "";
        return undefined;
      },
    });

    await deploy("Deploy dependency change");

    expect(wroteDataFile("pre-deploy-sha")).toBe(true);
    expect(unlinkedDataFile("pre-deploy-sha")).toBe(true);

    writeFileSyncCallMock.mockClear();
    unlinkSyncCallMock.mockClear();
    mockExistingRollbackCheckpoint();

    await deploy("Deploy dependency change", { sessionId: "session-2", toolCallId: "tool-2" });

    expect(wroteDataFile("pre-deploy-sha")).toBe(false);
    expect(unlinkedDataFile("pre-deploy-sha")).toBe(false);
  });

  it("returns a normalized failure result when staging_deploy hits a rebase conflict", async () => {
    const { stagingDir, deploy } = await setupDeployScenario({
      through: "rebase",
      respond: (cmd) => {
        if (cmd === "git rebase main") {
          failCommand("conflict", "CONFLICT (content): Merge conflict in src/server/staging-tools.ts\n");
        }
        if (cmd === "git rebase --abort") return "";
        return undefined;
      },
    });

    const result = await deploy("Test deploy");

    expect(result).toMatchObject({
      resultType: "failure",
      sessionLog: expect.stringContaining("Command: git rebase main"),
      toolTelemetry: {
        bridge: {
          command: "git rebase main",
          cwd: stagingDir,
          stagingDir,
          prodBranch: "main",
        },
      },
    });
    expect(result.textResultForLlm).toContain("Staging branch conflicts with production.");
    expect(result.textResultForLlm).toContain("The rebase has been aborted and your staging worktree is intact.");
    expect(result.textResultForLlm).toContain("Call staging_deploy again");
    expect(result.textResultForLlm).toContain("CONFLICT (content)");
    expect(result).not.toHaveProperty("error");
  });

  it("runs deploy validation before writing the checkpoint, merging, pushing, or signaling restart", async () => {
    const { deploy } = await setupDeployScenario({ name: "preview-ordering" });

    const result = await deploy("Ordering check", { sessionId: "session-order", toolCallId: "tool-order" });

    expect(result.success).toBe(true);

    const commands = executedCommands();
    const mergeIndex = commands.indexOf('git merge "staging/preview-ordering" --no-edit');
    const pushIndex = commands.indexOf("git push origin main");
    expect(mergeIndex).toBeGreaterThan(-1);
    expect(pushIndex).toBeGreaterThan(mergeIndex);

    // Every deploy validation command must appear before the merge
    for (const validationCmd of DEPLOY_VALIDATION_COMMANDS) {
      const idx = commands.indexOf(validationCmd);
      expect(idx, `${validationCmd} must appear before git merge`).toBeGreaterThan(-1);
      expect(idx, `${validationCmd} must appear before git merge`).toBeLessThan(mergeIndex);
    }
    const deployValidationSpawnCalls = spawnMock.mock.calls.filter(([cmd]) =>
      DEPLOY_VALIDATION_COMMANDS.includes(String(cmd) as (typeof DEPLOY_VALIDATION_COMMANDS)[number]),
    );
    expect(deployValidationSpawnCalls).toHaveLength(DEPLOY_VALIDATION_COMMANDS.length);
    for (const [, argsOrOptions, maybeOptions] of deployValidationSpawnCalls) {
      const options = (Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions) as MockSpawnOptions | undefined;
      expectIsolatedValidationEnv(options?.env);
    }

    // pre-deploy-sha checkpoint must be written before the atomic restart-signal temp
    const writtenPaths = writeFileSyncCallMock.mock.calls.map(([file]) => String(file));
    const checkpointWriteIndex = writtenPaths.findIndex((p) => isDataFilePath(p, "pre-deploy-sha"));
    const signalWriteIndex = writtenPaths.findIndex((p) => isRestartSignalTempPath(p));
    expect(checkpointWriteIndex, "pre-deploy-sha must be written").toBeGreaterThan(-1);
    expect(signalWriteIndex, "restart signal temp must be written").toBeGreaterThan(-1);
    expect(checkpointWriteIndex).toBeLessThan(signalWriteIndex);
    expect(requestRestartMock.mock.invocationCallOrder[0]).toBeLessThan(
      writeFileSyncCallMock.mock.invocationCallOrder[signalWriteIndex],
    );
  });

  it("writes the supplied commit message verbatim without adding a co-author trailer", async () => {
    const { deploy } = await setupDeployScenario({
      name: "preview-msg",
      respond: (cmd) => {
        if (cmd === "git --no-pager status --porcelain") return " M src/server/staging-tools.ts\n";
        return cmd.startsWith("git commit -F ") ? "" : undefined;
      },
    });
    const message = "Subject line\n\nBody paragraph.\n\nCo-authored-by: Someone <someone@example.com>";

    await deploy(message, { sessionId: "session-deploy-msg", toolCallId: "deploy-msg" });

    const commitMsgWrite = writeFileSyncCallMock.mock.calls.find(
      ([file]) => basename(String(file)) === ".commit-msg",
    );
    expect(commitMsgWrite).toBeDefined();
    expect(String(commitMsgWrite![1])).toBe(`${message}\n`);
  });
});
