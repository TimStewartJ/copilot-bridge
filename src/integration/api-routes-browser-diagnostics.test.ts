import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../test-support/api-routes.js";
import { createTestApp } from "../test-support/api-routes.js";
import { testPath } from "../server/__tests__/test-paths.js";
import type { AppContext } from "../server/app-context.js";
import {
  ab,
  getAgentBrowserVersion,
  isAgentBrowserInstalled,
  shutdownBridgeBrowser,
  type BrowserCommandResult,
  type BrowserShutdownResult,
} from "../server/agent-browser.js";
import {
  BrowserHeadedCloseError,
  checkAdoBrowserAuthentication,
  closeHeadedDiagnosticsBrowser,
  probeBrowserContext,
} from "../server/browser-diagnostics.js";
import { resetBrowserLaunchCachesForTests } from "../server/browser-launch.js";
import { getBrowserRuntime, type BrowserRuntime } from "../server/browser-runtime.js";

vi.mock("../server/browser-diagnostics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/browser-diagnostics.js")>();
  return {
    ...actual,
    checkAdoBrowserAuthentication: vi.fn(),
    closeHeadedDiagnosticsBrowser: vi.fn(),
    probeBrowserContext: vi.fn(),
  };
});

// The routes below run the real diagnostics, broker, session store and live gateway. Everything
// they would ask of agent-browser or a browser process is answered here instead.
vi.mock("../server/agent-browser.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../server/agent-browser.js")>(),
  ab: vi.fn(),
  getAgentBrowserVersion: vi.fn(),
  isAgentBrowserInstalled: vi.fn(),
  shutdownBridgeBrowser: vi.fn(),
}));

const checkAdoBrowserAuthenticationMock = vi.mocked(checkAdoBrowserAuthentication);
const closeHeadedDiagnosticsBrowserMock = vi.mocked(closeHeadedDiagnosticsBrowser);
const probeBrowserContextMock = vi.mocked(probeBrowserContext);
const abMock = vi.mocked(ab);
const getAgentBrowserVersionMock = vi.mocked(getAgentBrowserVersion);
const isAgentBrowserInstalledMock = vi.mocked(isAgentBrowserInstalled);
const shutdownBridgeBrowserMock = vi.mocked(shutdownBridgeBrowser);

const SAME_ORIGIN = { host: "localhost:3333", origin: "http://localhost:3333" };
const CROSS_SITE = { host: "localhost:3333", origin: "https://evil.example.test" };

/** A browser that closed and left no process behind. */
function cleanShutdown(overrides: Partial<BrowserShutdownResult> = {}): BrowserShutdownResult {
  return {
    ok: true,
    closeOk: true,
    terminatedPids: [],
    killedPids: [],
    remainingPids: [],
    clearedRuntimeFiles: 0,
    ...overrides,
  };
}

/** Answers the agent-browser `stream` commands of the live view; any other command succeeds. */
function answerStreamCommands(answers: { status: BrowserCommandResult; enable?: BrowserCommandResult }): void {
  abMock.mockImplementation(async (command) => {
    if (command[0] === "stream" && command[1] === "status") return answers.status;
    if (command[0] === "stream" && command[1] === "enable" && answers.enable) return answers.enable;
    return { ok: true, output: "" };
  });
}

function streamCommands(): string[] {
  return abMock.mock.calls.filter(([command]) => command[0] === "stream").map(([command]) => command.join(" "));
}

const browserRuntimes = new Set<BrowserRuntime>();

/** The app's browser machinery. Its browser sessions are closed when the test ends. */
function browserRuntimeOf(ctx: AppContext): BrowserRuntime {
  const runtime = getBrowserRuntime(ctx);
  browserRuntimes.add(runtime);
  return runtime;
}

function publicProfileRoot(ctx: AppContext): string {
  return path.join(ctx.copilotHome!, "browser-public");
}

function seedPublicProfile(ctx: AppContext, slot: number): string {
  const profileDir = path.join(publicProfileRoot(ctx), `slot-${slot}`);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(path.join(profileDir, "Cookies"), `slot ${slot}`);
  return profileDir;
}

beforeEach(() => {
  closeHeadedDiagnosticsBrowserMock.mockReset();
  probeBrowserContextMock.mockReset();
  checkAdoBrowserAuthenticationMock.mockReset();
  closeHeadedDiagnosticsBrowserMock.mockResolvedValue({
    ok: true,
    sessionName: "copilot-bridge-test",
    masterProfileDirectory: testPath("browser-profile"),
    message: "Headed browser close requested. Verified browser state is ready for future browser tool runs.",
  });
  probeBrowserContextMock.mockResolvedValue({
    ok: true,
    context: "public",
    state: "ready",
    checkedAt: new Date().toISOString(),
  });
  checkAdoBrowserAuthenticationMock.mockResolvedValue({
    service: "ado",
    state: "verified",
    checkedAt: new Date().toISOString(),
    finalOrigin: "https://msazure.visualstudio.com",
    expectedOrigin: "https://msazure.visualstudio.com",
  });

  abMock.mockReset().mockResolvedValue({ ok: true, output: "" });
  getAgentBrowserVersionMock.mockReset().mockResolvedValue("0.38.2");
  isAgentBrowserInstalledMock.mockReset().mockResolvedValue(true);
  shutdownBridgeBrowserMock.mockReset().mockImplementation(async () => cleanShutdown());

  // The machine running the tests may configure its own browser.
  vi.stubEnv("AGENT_BROWSER_EXECUTABLE_PATH", undefined);
  vi.stubEnv("AGENT_BROWSER_ARGS", undefined);
  vi.stubEnv("AGENT_BROWSER_CONFIG", undefined);
  resetBrowserLaunchCachesForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  shutdownBridgeBrowserMock.mockReset().mockImplementation(async () => cleanShutdown());
  const runtimes = [...browserRuntimes];
  browserRuntimes.clear();
  for (const runtime of runtimes) {
    runtime.live.shutdown();
    await runtime.sessions.closeAll();
  }
});

describe("Browser diagnostics routes", () => {
  it("GET /api/browser/diagnostics returns separate browser contexts", async () => {
    const local = createTestApp();

    const res = await request(local.app).get("/api/browser/diagnostics");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      schemaVersion: 3,
      agentBrowserInstalled: true,
      config: {
        executablePathSource: "auto-detect",
        executablePathConfigured: false,
        browser: { kind: "chrome-for-testing" },
        launch: {
          args: ["--disable-blink-features=AutomationControlled", "--enable-unsafe-swiftshader", "about:blank"],
          inheritedFrom: "none",
        },
        agentBrowserVersion: "0.38.2",
      },
      runtime: {
        transport: {
          kind: "cli",
          namespace: "copilot-bridge",
        },
      },
      contexts: {
        public: {
          context: "public",
          profileRoot: publicProfileRoot(local.ctx),
          profiles: 0,
          profilesInUse: 0,
        },
        authenticated: { context: "authenticated" },
      },
      issues: [],
    });
    expect(res.body.config).not.toHaveProperty("executablePath");
    // Nothing has checked or used a live view yet.
    expect(res.body.config).not.toHaveProperty("liveView");
  });

  it("GET /api/browser/diagnostics reports what the last check of the live view found", async () => {
    const local = createTestApp();
    const check = { ok: false, checkedAt: "2026-03-10T12:00:00.000Z", message: "The stream sent no picture of the page." };
    vi.spyOn(browserRuntimeOf(local.ctx).live, "getLastCheck").mockReturnValue(check);

    const res = await request(local.app).get("/api/browser/diagnostics");

    expect(res.status).toBe(200);
    expect(res.body.config.liveView).toEqual(check);
  });

  it("GET /api/browser/diagnostics counts public profiles and lists blocked pages", async () => {
    const local = createTestApp();
    seedPublicProfile(local.ctx, 1);
    seedPublicProfile(local.ctx, 2);
    const lease = await browserRuntimeOf(local.ctx).broker.createSessionTarget("public");
    for (const by of ["Cloudflare", "DataDome", "Cloudflare"]) {
      local.ctx.telemetryStore!.recordSpan({
        name: "browser.page.blocked",
        duration: 0,
        source: "server",
        metadata: { kind: "challenge", by },
      });
    }

    const res = await request(local.app).get("/api/browser/diagnostics");

    expect(res.status).toBe(200);
    expect(res.body.contexts.public).toMatchObject({ profiles: 2, profilesInUse: 1 });
    expect(res.body.issues).toEqual([
      { code: "page.blocked.cloudflare", label: "Blocked by Cloudflare", count: 2, latestAt: expect.any(String) },
      { code: "page.blocked.datadome", label: "Blocked by DataDome", count: 1, latestAt: expect.any(String) },
    ]);
    await browserRuntimeOf(local.ctx).broker.disposeSessionTarget(lease, { toolName: "test", browserOpId: "op-1" });
  });

  it.each([
    ["launch-headed", "Headed browser launch must be started from the Bridge UI."],
    ["close-headed", "Headed browser close must be started from the Bridge UI."],
    ["public/reset", "Public browser data reset must be started from the Bridge UI."],
  ])("POST /api/browser/diagnostics/%s rejects cross-site requests", async (route, error) => {
    const local = createTestApp();
    const profile = seedPublicProfile(local.ctx, 1);

    const res = await request(local.app)
      .post(`/api/browser/diagnostics/${route}`)
      .set("Host", CROSS_SITE.host)
      .set("Origin", CROSS_SITE.origin)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(error);
    expect(closeHeadedDiagnosticsBrowserMock).not.toHaveBeenCalled();
    expect(existsSync(path.join(profile, "Cookies"))).toBe(true);
  });

  it("POST /api/browser/diagnostics/probe checks the requested context", async () => {
    const local = createTestApp();

    const res = await request(local.app)
      .post("/api/browser/diagnostics/probe")
      .set("Host", "localhost:3333")
      .set("Origin", "http://localhost:3333")
      .send({ context: "public" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, context: "public", state: "ready" });
    expect(probeBrowserContextMock).toHaveBeenCalledWith(expect.anything(), "public");
  });

  it("POST /api/browser/diagnostics/authenticated/check/ado verifies authentication", async () => {
    const local = createTestApp();

    const res = await request(local.app)
      .post("/api/browser/diagnostics/authenticated/check/ado")
      .set("Host", "localhost:3333")
      .set("Origin", "http://localhost:3333")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      service: "ado",
      state: "verified",
    });
    expect(checkAdoBrowserAuthenticationMock).toHaveBeenCalledWith(expect.anything());
  });

  it("authenticated browser aliases preserve close behavior", async () => {
    const local = createTestApp();

    const res = await request(local.app)
      .post("/api/browser/diagnostics/authenticated/close-headed")
      .set("Host", "localhost:3333")
      .set("Origin", "http://localhost:3333")
      .send({});

    expect(res.status).toBe(200);
    expect(closeHeadedDiagnosticsBrowserMock).toHaveBeenCalledWith(expect.anything());
  });

  it("POST /api/browser/diagnostics/close-headed answers 400 with the details of a close that failed", async () => {
    closeHeadedDiagnosticsBrowserMock.mockRejectedValue(new BrowserHeadedCloseError({
      ok: false,
      failureCode: "profile_processes_remaining",
      outputSummary: "Profile-bound browser processes remain after shutdown: 4242",
      closeOk: true,
      terminatedPids: [4242],
      killedPids: [],
      remainingPids: [4242],
      clearedRuntimeFiles: 0,
    }));
    const local = createTestApp();

    const res = await request(local.app)
      .post("/api/browser/diagnostics/close-headed")
      .set("Host", "localhost:3333")
      .set("Origin", "http://localhost:3333")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("remaining profile-bound browser process PIDs: 4242");
    expect(res.body.details).toMatchObject({
      failureCode: "profile_processes_remaining",
      remainingPids: [4242],
    });
  });
});

describe("POST /api/browser/diagnostics/public/reset", () => {
  it("clears the public profiles nothing is using and reports the one in use", async () => {
    const local = createTestApp();
    const leasedProfile = seedPublicProfile(local.ctx, 1);
    const idleProfile = seedPublicProfile(local.ctx, 2);
    const authenticatedCookies = path.join(local.ctx.copilotHome!, "browser-profile", "Cookies");
    mkdirSync(path.dirname(authenticatedCookies), { recursive: true });
    writeFileSync(authenticatedCookies, "signed in");
    const broker = browserRuntimeOf(local.ctx).broker;
    const lease = await broker.createSessionTarget("public");
    expect(lease.browserTarget.profileDir).toBe(leasedProfile);

    const res = await request(local.app)
      .post("/api/browser/diagnostics/public/reset")
      .set("Host", SAME_ORIGIN.host)
      .set("Origin", SAME_ORIGIN.origin)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, cleared: 1, inUse: 1 });
    expect(existsSync(idleProfile)).toBe(false);
    expect(existsSync(path.join(leasedProfile, "Cookies"))).toBe(true);
    expect(existsSync(authenticatedCookies)).toBe(true);
    // A browser left on a profile is closed before its data goes; none of them is the signed-in one.
    const closedProfiles = shutdownBridgeBrowserMock.mock.calls.map(([target]) => target?.profileDir);
    expect(closedProfiles).toContain(idleProfile);
    expect(closedProfiles).not.toContain(path.dirname(authenticatedCookies));

    await broker.disposeSessionTarget(lease, { toolName: "test", browserOpId: "op-1" });
    const again = await request(local.app)
      .post("/api/browser/diagnostics/public/reset")
      .set("Host", SAME_ORIGIN.host)
      .set("Origin", SAME_ORIGIN.origin)
      .send({});
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true, cleared: 1, inUse: 0 });
    expect(existsSync(leasedProfile)).toBe(false);
  });

  it("answers 500 when the folder of the profiles cannot be read", async () => {
    const local = createTestApp();
    // A file where the folder belongs.
    mkdirSync(local.ctx.copilotHome!, { recursive: true });
    writeFileSync(publicProfileRoot(local.ctx), "");

    const res = await request(local.app)
      .post("/api/browser/diagnostics/public/reset")
      .set("Host", SAME_ORIGIN.host)
      .set("Origin", SAME_ORIGIN.origin)
      .send({});

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: expect.stringContaining("ENOTDIR") });
    expect(shutdownBridgeBrowserMock).not.toHaveBeenCalled();
  });

});

describe("POST /api/browser/sessions/:browserSessionId/live", () => {
  async function startBrowserSession(ctx: AppContext) {
    return browserRuntimeOf(ctx).sessions.createSession("chat-session-1", "public", "live view test");
  }

  function requestLiveView(app: Parameters<typeof request>[0], browserSessionId: string, headers = SAME_ORIGIN) {
    return request(app)
      .post(`/api/browser/sessions/${browserSessionId}/live`)
      .set("Host", headers.host)
      .set("Origin", headers.origin)
      .send({});
  }

  it("returns a ticket for a browser session whose stream is running", async () => {
    const local = createTestApp();
    const session = await startBrowserSession(local.ctx);
    answerStreamCommands({ status: { ok: true, output: "", data: { enabled: true, port: 9333 } } });
    const requestedAt = Date.now();

    const res = await requestLiveView(local.app, session.id);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["browserSessionId", "expiresAt", "token"]);
    expect(res.body.browserSessionId).toBe(session.id);
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(requestedAt);
    // The stream is asked for in the session's own browser.
    expect(abMock).toHaveBeenCalledWith(["stream", "status"], expect.any(Number), expect.objectContaining({
      browserTarget: session.browserTarget,
    }));
  });

  it("answers 404 for a browser session that never existed", async () => {
    const local = createTestApp();

    const res = await requestLiveView(local.app, "bs_missing");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Browser session bs_missing has ended." });
    expect(abMock).not.toHaveBeenCalled();
  });

  it("answers 409 when the installed agent-browser has no stream command", async () => {
    const local = createTestApp();
    const session = await startBrowserSession(local.ctx);
    answerStreamCommands({
      status: { ok: false, output: "Unknown command: stream" },
      enable: { ok: true, output: "", data: { enabled: true, port: 9444 } },
    });

    const res = await requestLiveView(local.app, session.id);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("cannot show a live browser");
    expect(res.body.error).toContain("npm install -g agent-browser@latest");
    expect(res.body).not.toHaveProperty("token");
  });

  it("answers 409 when the session's browser does not start", async () => {
    const local = createTestApp();
    const session = await startBrowserSession(local.ctx);
    const { BrowserUnavailableError } = await import("../server/browser-broker.js");
    // What the broker reports when its readiness check fails; the check itself has its own tests.
    const createTicket = vi.spyOn(browserRuntimeOf(local.ctx).live, "createTicket").mockRejectedValue(
      new BrowserUnavailableError("Browser public context is unavailable: Chrome exited early"),
    );

    const res = await requestLiveView(local.app, session.id);

    expect(createTicket).toHaveBeenCalledWith(session.id);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Browser public context is unavailable: Chrome exited early" });
  });

  it("answers 500 when the stream command itself breaks", async () => {
    const local = createTestApp();
    const session = await startBrowserSession(local.ctx);
    abMock.mockRejectedValue(new Error("spawn EAGAIN"));

    const res = await requestLiveView(local.app, session.id);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "spawn EAGAIN" });
  });

  it("rejects cross-site requests before looking at the session", async () => {
    const local = createTestApp();
    const session = await startBrowserSession(local.ctx);

    const res = await requestLiveView(local.app, session.id, CROSS_SITE);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Live browser view must be started from the Bridge UI.");
    expect(streamCommands()).toEqual([]);
  });
});
