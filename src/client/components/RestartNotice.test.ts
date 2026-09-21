import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../test-react-harness";
import RestartNotice, { describeWaiting } from "./RestartNotice";

let harness: ReactDomHarness | undefined;
afterEach(async () => { await harness?.cleanup(); harness = undefined; });

async function renderNotice(props: Parameters<typeof RestartNotice>[0]) {
  harness = await createReactDomHarness();
  await harness.render(createElement(RestartNotice, props));
  return harness.dom.container.textContent ?? "";
}

describe("RestartNotice", () => {
  it("shows one quiet waiting line rather than a warning or a work lock", async () => {
    const text = await renderNotice({ notice: { kind: "waiting", sessions: 2, jobs: 1, sessionIds: [] } });
    expect(text).toContain("Restart pending");
    expect(text).toContain("after 2 sessions and 1 job finish");
    expect(text).not.toMatch(/paused|imminent|abort/i);
    const root = harness!.dom.container.childNodes[0];
    expect(getReactProps(root)?.className).toContain("py-1");
    expect(getReactProps(root)?.className).not.toMatch(/warning|error/);
    expect(findAllByTag(harness!.dom.container, "svg").some((node) =>
      String(getReactProps(node)?.className).includes("animate-spin"))).toBe(false);
  });

  it("reports the sessions it waits for and allows an explicit restart-now action", async () => {
    const restart = vi.fn();
    await renderNotice({ notice: { kind: "waiting", sessions: 1, jobs: 0, sessionIds: ["a"] },
      waitingSessionTitles: ["Current work"], onRestartNow: restart });
    expect(getReactProps(harness!.dom.container.childNodes[0])?.title).toBe("Waiting for: Current work");
    const button = findAllByTag(harness!.dom.container, "button")[0];
    expect(button.textContent).toBe("Restart now");
    await harness!.act(async () => { getReactProps(button)?.onClick?.(); });
    expect(restart).toHaveBeenCalledOnce();
  });

  it("does not promise a forced reload while unsent work holds it back", async () => {
    const text = await renderNotice({ notice: { kind: "restarted" }, reloadHeld: true, onReload: vi.fn() });
    expect(text).toContain("reloads once your unsent work is safe");
    expect(text).not.toContain("reloading");
    expect(findAllByTag(harness!.dom.container, "button")[0].textContent).toBe("Reload now");
  });

  it("uses singular grammar and distinguishes actual restart from waiting", async () => {
    expect(describeWaiting(1, 0)).toBe("after 1 session finishes");
    expect(describeWaiting(0, 1)).toBe("after 1 job finishes");
    expect(describeWaiting(0, 0)).toBe("when Bridge is idle");
    expect(await renderNotice({ notice: { kind: "restarting" } })).toContain("Bridge is restarting");
  });
});
