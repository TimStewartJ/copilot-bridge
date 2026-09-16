import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
} from "../../test-react-harness";
import JsonTree, { JSON_TREE_LONG_STRING_CHARS } from "./JsonTree";

function buttonStartingWith(root: any, text: string) {
  return findAllByTag(root, "BUTTON").find((button) => button.textContent?.startsWith(text));
}

describe("JsonTree", () => {
  it("renders scalars and expands only shallow containers by default", async () => {
    const harness = await createReactDomHarness();
    await harness.render(createElement(JsonTree, {
      value: {
        buildId: 123,
        status: "running",
        done: false,
        notes: null,
        empty: {},
        list: [],
        prs: {
          "17166416": {
            status: "active",
            head: "57ebc412791974ad6d95a0759f51740d8e1e37e1",
            votes: [{ displayName: "Tim", vote: 0 }],
          },
        },
      },
    }));
    const container = harness.dom.container;
    const text = () => container.textContent ?? "";

    expect(text()).toContain('buildId:123status:"running"done:falsenotes:nullempty:{}list:[]prs:{1}');
    expect(getReactProps(buttonStartingWith(container, "prs:"))?.["aria-expanded"]).toBe(true);
    const pr = buttonStartingWith(container, "17166416:");
    expect(pr?.textContent).toBe('17166416:{3}{ status: "active", head: "57ebc412791974ad…", votes: [1] }');
    expect(getReactProps(pr)?.["aria-expanded"]).toBe(false);

    await harness.act(async () => {
      getReactProps(buttonStartingWith(container, "17166416:"))?.onClick?.();
    });
    expect(text()).toContain('head:"57ebc412791974ad6d95a0759f51740d8e1e37e1"');
    expect(buttonStartingWith(container, "votes:")?.textContent).toBe("votes:[1][{…}]");

    await harness.act(async () => {
      getReactProps(buttonStartingWith(container, "votes:"))?.onClick?.();
    });
    expect(buttonStartingWith(container, "0:")?.textContent).toBe('0:{2}{ displayName: "Tim", vote: 0 }');

    await harness.act(async () => {
      getReactProps(buttonStartingWith(container, "prs:"))?.onClick?.();
    });
    expect(buttonStartingWith(container, "prs:")?.textContent).toBe("prs:{1}{ 17166416: {…} }");
    expect(text()).not.toContain("head:");
    await harness.cleanup();
  });

  it("truncates long strings until expanded", async () => {
    const extra = 1_234;
    const long = `${"a".repeat(JSON_TREE_LONG_STRING_CHARS)}${"b".repeat(extra)}`;
    const harness = await createReactDomHarness();
    await harness.render(createElement(JsonTree, { value: { state: long, short: "fine" } }));
    const container = harness.dom.container;

    expect(container.textContent).toContain(`state:"${"a".repeat(JSON_TREE_LONG_STRING_CHARS)}…"+1,234 chars`);
    expect(container.textContent).not.toContain("b");

    await harness.act(async () => {
      getReactProps(buttonStartingWith(container, "+1,234 chars"))?.onClick?.();
    });
    expect(container.textContent).toContain(`state:"${long}"Show less`);
    expect(container.textContent).toContain('short:"fine"');
    await harness.cleanup();
  });

  it("labels array indices, empty roots, and a zero expansion depth", async () => {
    const harness = await createReactDomHarness();
    await harness.render(createElement(JsonTree, { value: ["first", 2, { nested: true }], defaultExpandDepth: 0 }));
    expect(harness.dom.container.textContent).toBe('0:"first"1:22:{1}{ nested: true }');

    await harness.render(createElement(JsonTree, { value: {} }));
    expect(harness.dom.container.textContent).toBe("Empty object");

    await harness.render(createElement(JsonTree, { value: [] }));
    expect(harness.dom.container.textContent).toBe("Empty list");
    await harness.cleanup();
  });
});
