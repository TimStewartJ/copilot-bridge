import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../app-context.js";
import { shutdownAppContextServices } from "../app-context-shutdown.js";
import { createServerShutdownCoordinator } from "../shutdown-coordinator.js";

vi.mock("../app-context-shutdown.js", () => ({
  SERVER_SHUTDOWN_BUDGET_MS: 13_000,
  shutdownAppContextServices: vi.fn(),
}));

const shutdownServicesMock = vi.mocked(shutdownAppContextServices);
const ctx = {} as AppContext;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  shutdownServicesMock.mockReset();
  vi.restoreAllMocks();
});

describe("server shutdown coordinator", () => {
  it("starts the handoff with the shutdown and exits only once both are done", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const services = deferred();
    const handoff = deferred();
    shutdownServicesMock.mockReturnValue(services.promise);
    const saveHandoff = vi.fn(() => handoff.promise);
    const exit = vi.fn();
    const coordinator = createServerShutdownCoordinator(ctx, { exit, saveHandoff });

    const operation = coordinator.request("test");
    // Stopping the services must not wait for the handoff: it stops admitting work in the request's tick.
    expect(shutdownServicesMock).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(saveHandoff, "started before the services have stopped").toHaveBeenCalledOnce();

    services.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(exit, "the handoff is still being written").not.toHaveBeenCalled();

    handoff.resolve();
    await operation;
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("exits cleanly when the handoff fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    shutdownServicesMock.mockResolvedValue(undefined);
    const exit = vi.fn();
    const coordinator = createServerShutdownCoordinator(ctx, {
      exit,
      saveHandoff: () => {
        throw new Error("disk full");
      },
    });

    await coordinator.request("test");

    expect(errorSpy).toHaveBeenCalledWith("[web] Saving state for the next server failed:", expect.any(Error));
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
