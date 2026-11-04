import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../test-react-harness";
import RestartNotice from "./RestartNotice";

let harness: ReactDomHarness | undefined;
afterEach(async () => { await harness?.cleanup(); harness = undefined; });

async function renderNotice(props: Parameters<typeof RestartNotice>[0]) {
  harness = await createReactDomHarness();
  await harness.render(createElement(RestartNotice, props));
  return harness.dom.container.textContent ?? "";
}

describe("RestartNotice", () => {
  it("reports the sessions it waits for and allows an explicit restart-now action", async () => {
    const restart = vi.fn();
    const text = await renderNotice({ notice: { kind: "waiting", sessions: 2, jobs: 1, sessionIds: ["a"] },
      waitingSessionTitles: ["Current work"], onRestartNow: restart });
    expect(text).toContain("after 2 sessions and 1 job finish");
    expect(getReactProps(harness!.dom.container.childNodes[0])?.title).toBe("Waiting for: Current work");
    const button = findAllByTag(harness!.dom.container, "button")[0];
    expect(button.textContent).toBe("Restart now");
    await harness!.act(async () => { getReactProps(button)?.onClick?.(); });
    expect(restart).toHaveBeenCalledOnce();
    await harness!.render(createElement(RestartNotice, { notice: { kind: "restarting" } }));
    expect(harness!.dom.container.textContent).toMatch(/\brestarting\b/i);
    expect(findAllByTag(harness!.dom.container, "BUTTON")).toHaveLength(0);
  });

  it("does not promise a forced reload while unsent work holds it back", async () => {
    const text = await renderNotice({ notice: { kind: "restarted" }, reloadHeld: true, onReload: vi.fn() });
    expect(text).toContain("reloads once your unsent work is safe");
    expect(text).not.toContain("reloading");
    expect(findAllByTag(harness!.dom.container, "button")[0].textContent).toBe("Reload now");
  });
});
