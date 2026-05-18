import { createElement } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { createReactDomHarness, type Act } from "../test-react-harness";
import { getSearchWithParam, getSearchWithoutParam, useOverlayParam } from "./useOverlayParam";

type OverlayHarnessApi = {
  location: string;
  open: (paramValue?: string) => void;
  close: () => void;
  back: () => void;
};

function OverlayHarness({ setApi }: { setApi: (api: OverlayHarnessApi) => void }) {
  const overlay = useOverlayParam("sheet");
  const location = useLocation();
  const navigate = useNavigate();

  setApi({
    location: `${location.pathname}${location.search}${location.hash}`,
    open: overlay.open,
    close: overlay.close,
    back: () => { void navigate(-1); },
  });

  return null;
}

async function withOverlayHarness(
  initialEntries: string[],
  initialIndex: number,
  run: (
    getApi: () => OverlayHarnessApi,
    act: Act,
  ) => Promise<void>,
) {
  const harness = await createReactDomHarness();
  let api: OverlayHarnessApi | null = null;
  const getApi = () => {
    if (!api) throw new Error("Overlay harness did not render");
    return api;
  };

  try {
    await harness.render(createElement(
      MemoryRouter,
      { initialEntries, initialIndex },
      createElement(OverlayHarness, { setApi: (nextApi) => { api = nextApi; } }),
    ));

    await run(getApi, harness.act);
  } finally {
    await harness.cleanup();
  }
}

describe("useOverlayParam search helpers", () => {
  it("removes the overlay parameter without leaving an empty query marker", () => {
    expect(getSearchWithoutParam("?sheet=plan", "sheet")).toBe("");
  });

  it("preserves unrelated parameters when closing the overlay", () => {
    expect(getSearchWithoutParam("?task=one&sheet=plan&view=chat", "sheet")).toBe("?task=one&view=chat");
  });

  it("adds or updates the overlay parameter when opening the overlay", () => {
    expect(getSearchWithParam("?task=one&sheet=notes", "sheet", "plan")).toBe("?task=one&sheet=plan");
  });
});

describe("useOverlayParam navigation behavior", () => {
  it("pops an overlay entry opened from the current page", async () => {
    await withOverlayHarness(["/home", "/sessions/abc"], 1, async (getApi, act) => {
      expect(getApi().location).toBe("/sessions/abc");

      await act(async () => { getApi().open("plan"); });
      expect(getApi().location).toBe("/sessions/abc?sheet=plan");

      await act(async () => { getApi().close(); });
      expect(getApi().location).toBe("/sessions/abc");

      await act(async () => { getApi().back(); });
      expect(getApi().location).toBe("/home");
    });
  });

  it("replaces a direct-linked overlay URL instead of leaving the page", async () => {
    await withOverlayHarness(["/home", "/sessions/abc?sheet=plan"], 1, async (getApi, act) => {
      expect(getApi().location).toBe("/sessions/abc?sheet=plan");

      await act(async () => { getApi().close(); });
      expect(getApi().location).toBe("/sessions/abc");
    });
  });

  it("does not stack duplicate entries for an overlay that is already open", async () => {
    await withOverlayHarness(["/home", "/sessions/abc"], 1, async (getApi, act) => {
      await act(async () => { getApi().open("plan"); });
      await act(async () => { getApi().open("plan"); });
      expect(getApi().location).toBe("/sessions/abc?sheet=plan");

      await act(async () => { getApi().close(); });
      expect(getApi().location).toBe("/sessions/abc");

      await act(async () => { getApi().back(); });
      expect(getApi().location).toBe("/home");
    });
  });
});
