import { createElement, useEffect, useState } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../test-react-harness";
import { useSearchBackground } from "./useSearchBackground";

describe("floating search route retention", () => {
  let harness: ReactDomHarness | undefined;
  afterEach(async () => { await harness?.cleanup(); });

  it("keeps the source mounted with draft, hash, and state through filtering, close, and history", async () => {
    const unmount = vi.fn();
    function Background() {
      const [draft, setDraft] = useState("");
      const location = useLocation();
      useEffect(() => () => { unmount(); }, []);
      return createElement("section", null,
        createElement("input", { value: draft, onChange: (event: { target: { value: string } }) => setDraft(event.target.value) }),
        `${location.pathname}${location.hash}:${location.state?.retained}`,
      );
    }
    function Shell() {
      const { actual, location, open, close } = useSearchBackground();
      const navigate = useNavigate();
      return createElement("div", null,
        createElement("button", { onClick: () => navigate("/search") }, "Open"),
        createElement("button", { onClick: () => navigate("/search?q=needle&type=task", { replace: true }) }, "Filter"),
        createElement("button", { onClick: close }, "Close"),
        createElement("button", { onClick: () => navigate(-1) }, "Back"),
        createElement("button", { onClick: () => navigate(1) }, "Forward"),
        createElement("output", null, `${actual.pathname}:${open}`),
        createElement("main", { inert: open || undefined },
          createElement(Routes, { location },
            createElement(Route, { path: "*", element: createElement(Background) }),
          )),
      );
    }
    harness = await createReactDomHarness();
    await harness.render(createElement(MemoryRouter, {
      initialEntries: [{ pathname: "/tasks/task-1", hash: "#notes", state: { retained: "yes" } }],
    }, createElement(Shell)));
    const input = findAllByTag(harness.dom.container, "INPUT")[0];
    await harness.act(async () => { getReactProps(input)?.onChange?.({ target: { value: "Unsent draft" } }); });
    const click = async (label: string) => harness!.act(async () => {
      const button = findAllByTag(harness!.dom.container, "BUTTON").find((node) => node.textContent === label);
      getReactProps(button)?.onClick?.();
    });
    for (const label of ["Open", "Filter", "Back", "Forward", "Close"]) {
      await click(label);
      expect(findAllByTag(harness.dom.container, "INPUT")[0]).toBe(input);
      expect(getReactProps(input)?.value).toBe("Unsent draft");
      expect(harness.dom.container.textContent).toContain("/tasks/task-1#notes:yes");
      expect(unmount).not.toHaveBeenCalled();
    }
    expect(harness.dom.container.textContent).toContain("/tasks/task-1:false");
    expect(getReactProps(findAllByTag(harness.dom.container, "MAIN")[0])?.inert).toBeUndefined();
  });

  it("uses a safe non-search background for direct search URLs", async () => {
    function Probe() {
      const { location, open } = useSearchBackground();
      return createElement("output", null, `${location.pathname}:${location.search}:${open}`);
    }
    harness = await createReactDomHarness();
    await harness.render(createElement(MemoryRouter, { initialEntries: ["/search?q=needle&from=%2Fsearch"] }, createElement(Probe)));
    expect(harness.dom.container.textContent).toBe("/::true");
  });

  it("honors the return URL on reload without allowing a search or external background", async () => {
    function Probe() {
      const { location } = useSearchBackground();
      return createElement("output", null, `${location.pathname}${location.search}${location.hash}`);
    }
    harness = await createReactDomHarness();
    await harness.render(createElement(MemoryRouter, { initialEntries: ["/search?from=%2Ftasks%2Ftask-1%3Ftab%3Dnotes%23note"] }, createElement(Probe)));
    expect(harness.dom.container.textContent).toBe("/tasks/task-1?tab=notes#note");
  });

  it("preserves the background restoration policy and does not duplicate history when dismissed", async () => {
    function Probe() {
      const { actual, navigationType, close } = useSearchBackground();
      const navigate = useNavigate();
      return createElement("div", null,
        createElement("output", null, `${actual.pathname}:${navigationType}`),
        createElement("button", { onClick: () => navigate("/search") }, "Open"),
        createElement("button", { onClick: close }, "Close"),
        createElement("button", { onClick: () => navigate(-1) }, "Back"),
      );
    }
    harness = await createReactDomHarness();
    await harness.render(createElement(MemoryRouter, { initialEntries: ["/docs", "/tasks/task-1"] }, createElement(Probe)));
    const click = async (label: string) => harness!.act(async () => {
      getReactProps(findAllByTag(harness!.dom.container, "BUTTON").find((node) => node.textContent === label))?.onClick?.();
    });
    await click("Open");
    expect(harness.dom.container.textContent).toContain("/search:POP");
    await click("Close");
    await click("Open");
    await click("Close");
    await click("Back");
    expect(harness.dom.container.textContent).toContain("/docs:POP");
  });

  it("restores the control captured before the inert background blurs it", async () => {
    function Probe() {
      const { open, close } = useSearchBackground();
      const navigate = useNavigate();
      useEffect(() => {
        if (open) document.body.focus();
      }, [open]);
      return createElement("div", null,
        createElement("textarea"),
        createElement("button", { onClick: () => navigate("/search") }, "Open"),
        createElement("button", { onClick: close }, "Close"),
      );
    }
    harness = await createReactDomHarness();
    await harness.render(createElement(MemoryRouter, { initialEntries: ["/tasks/task-1"] }, createElement(Probe)));
    const textarea = findAllByTag(harness.dom.container, "TEXTAREA")[0];
    Object.defineProperty(textarea, "isConnected", { configurable: true, value: true });
    textarea.focus();
    const buttons = findAllByTag(harness.dom.container, "BUTTON");
    await harness.act(async () => { getReactProps(buttons[0])?.onClick?.(); });
    expect(document.activeElement).not.toBe(textarea);
    await harness.act(async () => { getReactProps(buttons[1])?.onClick?.(); });
    expect(document.activeElement).toBe(textarea);
  });
});
