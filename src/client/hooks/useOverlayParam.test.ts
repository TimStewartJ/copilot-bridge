import { createElement } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { createReactDomHarness, type Act } from "../test-react-harness";
import { getSearchWithParam, getSearchWithoutParam, useOverlayParam } from "./useOverlayParam";

type OverlayHarnessApi = {
  location: string;
  state: unknown;
  open: (paramValue?: string, options?: { replace?: boolean }) => void;
  close: () => void;
  back: () => void;
};

function OverlayHarness({ setApi }: { setApi: (api: OverlayHarnessApi) => void }) {
  const overlay = useOverlayParam("sheet");
  const location = useLocation();
  const navigate = useNavigate();

  setApi({
    location: `${location.pathname}${location.search}${location.hash}`,
    state: location.state,
    open: overlay.open,
    close: overlay.close,
    back: () => { void navigate(-1); },
  });

  return null;
}

async function withOverlayHarness(
  initialEntries: (string | { pathname: string; search?: string; state: unknown })[],
  initialIndex: number,
  run: (
    getApi: () => OverlayHarnessApi,
    act: Act,
    remount: () => Promise<void>,
  ) => Promise<void>,
) {
  const harness = await createReactDomHarness();
  let api: OverlayHarnessApi | null = null;
  const getApi = () => {
    if (!api) throw new Error("Overlay harness did not render");
    return api;
  };

  try {
    let mount = 0;
    const remount = () => harness.render(createElement(
      MemoryRouter,
      { initialEntries, initialIndex },
      createElement(OverlayHarness, { key: ++mount, setApi: (nextApi) => { api = nextApi; } }),
    ));
    await remount();
    await run(getApi, harness.act, remount);
  } finally {
    await harness.cleanup();
  }
}

describe("useOverlayParam search helpers", () => {
  it("removes, preserves, or updates overlay parameters via buildOverlaySearch", () => {
    const cases: [string, string, string][] = [
      // removes without leaving empty query marker
      ["?sheet=plan", "", "getSearchWithoutParam removes sole param"],
      // preserves unrelated params when closing
      ["?task=one&sheet=plan&view=chat", "?task=one&view=chat", "getSearchWithoutParam preserves unrelated params"],
    ];
    for (const [input, expected, label] of cases) {
      expect(getSearchWithoutParam(input, "sheet"), `case: ${label}`).toBe(expected);
    }
    // adds or updates the overlay parameter when opening
    expect(getSearchWithParam("?task=one&sheet=notes", "sheet", "plan"), "case: getSearchWithParam updates").toBe("?task=one&sheet=plan");
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

  it("ignores a save's late dismissal after the user already went Back", async () => {
    await withOverlayHarness(["/home", "/sessions/abc"], 1, async (getApi, act) => {
      await act(async () => { getApi().open("plan"); });
      const closeAfterSave = getApi().close;
      await act(async () => { getApi().back(); });
      await act(async () => { closeAfterSave(); });
      expect(getApi().location).toBe("/sessions/abc");
    });
  });

  it("replaces a direct-linked overlay URL instead of leaving the page", async () => {
    const state = { returnTo: "parent" };
    await withOverlayHarness(["/home", { pathname: "/sessions/abc", search: "?sheet=plan", state }], 1, async (getApi, act) => {
      expect(getApi().location).toBe("/sessions/abc?sheet=plan");

      await act(async () => { getApi().close(); });
      expect(getApi().location).toBe("/sessions/abc");
      expect(getApi().state).toEqual(state);
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

  it("keeps the underlying entry and its return state when overlay content is replaced", async () => {
    const state = { returnTo: "home-card" };
    await withOverlayHarness(["/home", { pathname: "/sessions/abc", state }], 1, async (getApi, act, remount) => {
      await act(async () => { getApi().open("one"); });
      await act(async () => { getApi().open("two", { replace: true }); });
      expect(getApi().location).toBe("/sessions/abc?sheet=two");
      expect(getApi().state).toMatchObject(state);
      await remount();
      await act(async () => { getApi().close(); });
      expect(getApi().location).toBe("/sessions/abc");
      await act(async () => { getApi().back(); });
      expect(getApi().location).toBe("/home");
    });
  });

  it("does not claim a direct-linked overlay when replacing its content", async () => {
    await withOverlayHarness(["/home", "/sessions/abc?sheet=one"], 1, async (getApi, act) => {
      await act(async () => { getApi().open("two", { replace: true }); });
      await act(async () => { getApi().close(); });
      expect(getApi().location).toBe("/sessions/abc");
    });
  });
});
