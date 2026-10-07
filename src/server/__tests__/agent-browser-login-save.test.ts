import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  spawn: spawnMock,
}));

const LOGIN = { url: "https://accounts.example.com/", username: "tim@example.com", password: "correct horse 42!" };
const TARGET = { sessionName: "test-browser", profileDir: "profile" };

/** A child process whose output a test writes and whose input it reads. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
    stdout: EventEmitter;
    stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
  };
  child.pid = 4242;
  child.exitCode = null;
  child.kill = vi.fn();
  child.stdout = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  spawnMock.mockReturnValueOnce(child);
  return child;
}

describe("saveAgentBrowserLogin", () => {
  beforeEach(() => {
    vi.resetModules();
    spawnMock.mockReset();
  });

  afterEach(async () => {
    const { resetProcessHostForTests } = await import("../process-host.js");
    await resetProcessHostForTests();
  });

  async function save(timeout?: number) {
    const child = fakeChild();
    const { saveAgentBrowserLogin } = await import("../agent-browser.js");
    const result = saveAgentBrowserLogin("bridge-1234-abcd", LOGIN, TARGET, timeout);
    // The command is started and the password written before anything is read from it.
    await vi.waitFor(() => expect(child.stdin.end).toHaveBeenCalled());
    return { child, result };
  }

  it("gives the password to the command on its input, and never as an argument", async () => {
    const { child, result } = await save();

    child.stdout.emit("data", Buffer.from('{"success":true,'));
    child.stdout.emit("data", Buffer.from('"data":{"saved":"bridge-1234-abcd"}}'));

    expect(await result).toMatchObject({ ok: true });
    expect(child.stdin.end).toHaveBeenCalledWith(LOGIN.password);
    const [file, args, options] = spawnMock.mock.calls[0];
    expect(file).toBe("agent-browser");
    expect(args).toEqual([
      "auth", "save", "bridge-1234-abcd", "--url", LOGIN.url, "--username", LOGIN.username, "--password-stdin", "--json",
    ]);
    expect(JSON.stringify([args, options.stdio])).not.toContain(LOGIN.password);
    // What the command would print to stderr is read by nobody.
    expect(options.stdio).toEqual(["pipe", "pipe", "ignore"]);
    expect(options.env).toMatchObject({ AGENT_BROWSER_SESSION: "test-browser", AGENT_BROWSER_PROFILE: "profile" });
    // The client can linger after printing its answer.
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("reports what agent-browser refused, without the password", async () => {
    const { child, result } = await save();

    child.stdout.emit("data", '{"success":false,"data":null,"error":"Invalid profile name"}');

    expect(await result).toEqual({ ok: false, output: "Invalid profile name" });
  });

  it("fails when the command ends or runs out of time without an answer", async () => {
    const ended = await save();
    ended.child.exitCode = 1;
    ended.child.emit("close", 1, null);
    expect(await ended.result).toMatchObject({ ok: false });
    expect(JSON.stringify(await ended.result)).not.toContain(LOGIN.password);
    expect(ended.child.kill).not.toHaveBeenCalled();

    const silent = await save(1);
    expect(await silent.result).toMatchObject({ ok: false, output: expect.stringContaining("did not save the login") });
    expect(silent.child.kill).toHaveBeenCalledTimes(1);
  });
});
