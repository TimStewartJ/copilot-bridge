import { createElement, createRef, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../test-react-harness";
import {
  Badge,
  Button,
  ChoiceButton,
  CountBadge,
  Details,
  DisclosureRow,
  Field,
  FieldList,
  FormRow,
  IconButton,
  IdentitySwatch,
  MetaLine,
  Notice,
  Panel,
  Section,
  SegmentedControl,
  STATUS_LABEL,
  StatusIcon,
} from "./primitives";
import { DS } from "./tokens";

describe("design primitives", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  async function render(element: ReactElement) {
    harness ??= await createReactDomHarness();
    await harness.render(element);
    return harness.dom.container;
  }

  async function click(element: any) {
    await harness!.act(async () => {
      getReactProps(element)?.onClick?.({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
  }

  it("makes a button that never submits a form by accident and is quiet unless told otherwise", async () => {
    const container = await render(createElement(Button, null, "Retry"));
    const props = getReactProps(findAllByTag(container, "BUTTON")[0]);
    expect(props?.type).toBe("button");
    expect(props?.className).toContain(DS.button.variant.secondary);
    expect(props?.className).not.toContain(DS.button.variant.primary);
  });

  it("forwards native refs through actions used by docs adapters and dialogs", async () => {
    const buttonRef = createRef<HTMLButtonElement>();
    const iconRef = createRef<HTMLButtonElement>();
    const container = await render(createElement("div", null,
      createElement(Button, { ref: buttonRef }, "Save"),
      createElement(IconButton, { ref: iconRef, label: "Close" }, "x"),
    ));
    const [button, icon] = findAllByTag(container, "BUTTON");
    expect(buttonRef.current).toBe(button);
    expect(iconRef.current).toBe(icon);
  });

  it("preserves state attributes on a canonical badge", async () => {
    const attributes = { tone: "warning", "aria-label": "Risk accepted", "data-focus-lifecycle": "accepted_risk" } as const;
    const container = await render(createElement(Badge, attributes, "Accepted risk"));
    const props = getReactProps(findAllByTag(container, "SPAN")[0]);
    expect(props?.["data-focus-lifecycle"]).toBe("accepted_risk");
    expect(props?.["aria-label"]).toBe("Risk accepted");
    expect(props?.className).toContain(DS.badge.tone.warning);
  });

  it("gives a significant region one group surface without boxing its values", async () => {
    const container = await render(createElement(Section, { label: "Sessions", surface: true, children: "rows" }));
    const section = findAllByTag(container, "SECTION")[0];
    expect(getReactProps(section)?.["data-ds-surface"]).toBe("group");
    expect(getReactProps(section)?.className).toContain(DS.surface.group);
    expect(getReactProps(section)?.className).not.toContain("shadow");
  });

  it("names an icon button for screen readers and on hover", async () => {
    const container = await render(createElement(IconButton, { label: "Close" }, "x"));
    const props = getReactProps(findAllByTag(container, "BUTTON")[0]);
    expect(props?.["aria-label"]).toBe("Close");
    expect(props?.title).toBe("Close");
  });

  it("keeps ordinary form labels visible with the container-sized label column", async () => {
    const container = await render(createElement(FormRow, {
      label: "Agent",
      htmlFor: "agent",
      children: createElement("input", { id: "agent" }),
    }));
    const label = findAllByTag(container, "LABEL")[0];
    expect(getReactProps(label)?.htmlFor).toBe("agent");
    expect(getReactProps(label)?.className).not.toContain("sr-only");
    const grid = findAllByTag(container, "DIV").find((element) => getReactProps(element)?.className?.startsWith("grid "));
    expect(getReactProps(grid)?.className).toContain("grid-cols-[5.5rem_minmax(0,1fr)]");
  });

  it("hides a redundant form label while preserving its association and reclaiming its column", async () => {
    const container = await render(createElement(FormRow, {
      label: "Agent",
      htmlFor: "agent",
      hideLabel: true,
      help: "Choose a specialist.",
      children: createElement("input", { id: "agent" }),
    }));
    const label = findAllByTag(container, "LABEL")[0];
    expect(label.textContent).toBe("Agent");
    expect(getReactProps(label)?.htmlFor).toBe(getReactProps(findAllByTag(container, "INPUT")[0])?.id);
    expect(getReactProps(label)?.className).toBe("sr-only");
    const grid = findAllByTag(container, "DIV").find((element) => getReactProps(element)?.className?.startsWith("grid "));
    expect(getReactProps(grid)?.className).not.toContain("grid-cols-");
    expect(container.textContent).toContain("Choose a specialist.");
  });

  it("reports a segmented choice once, and selects nothing when there is no value", async () => {
    const onChange = vi.fn();
    const options = [{ value: "task", label: "Task" }, { value: "ongoing", label: "Ongoing" }] as const;
    let container = await render(createElement(SegmentedControl<"task" | "ongoing">, {
      ariaLabel: "Task kind",
      options,
      value: "task",
      onChange,
    }));
    const group = findAllByTag(container, "DIV").find((element) => getReactProps(element)?.role === "group");
    expect(getReactProps(group)?.["aria-label"]).toBe("Task kind");
    let [task, ongoing] = findAllByTag(container, "BUTTON");
    expect(getReactProps(task)?.["aria-pressed"]).toBe(true);
    expect(getReactProps(ongoing)?.["aria-pressed"]).toBe(false);

    await click(task);
    expect(onChange).not.toHaveBeenCalled();
    await click(ongoing);
    expect(onChange).toHaveBeenCalledExactlyOnceWith("ongoing");

    container = await render(createElement(SegmentedControl<"task" | "ongoing">, {
      ariaLabel: "Task kind",
      options,
      value: undefined,
      onChange,
    }));
    [task, ongoing] = findAllByTag(container, "BUTTON");
    expect(getReactProps(task)?.["aria-pressed"]).toBe(false);
    expect(getReactProps(ongoing)?.["aria-pressed"]).toBe(false);
  });

  it("keeps an inherited placeholder selected and inert until a concrete value is chosen", async () => {
    const onChange = vi.fn();
    const options = [{ value: null, label: "Default" }, { value: "high", label: "High" }] as const;
    const container = await render(createElement(SegmentedControl<"high">, {
      ariaLabel: "Effort",
      options,
      value: undefined,
      onChange,
    }));
    const [placeholder, high] = findAllByTag(container, "BUTTON");
    expect(getReactProps(placeholder)?.["aria-pressed"]).toBe(true);
    expect(getReactProps(placeholder)?.disabled).toBe(true);
    await click(placeholder);
    expect(onChange).not.toHaveBeenCalled();
    await click(high);
    expect(onChange).toHaveBeenCalledExactlyOnceWith("high");
  });

  it("can reaffirm a launch choice, but never a disabled choice", async () => {
    const onChange = vi.fn();
    const onReselect = vi.fn();
    const props = {
      ariaLabel: "Effort",
      options: [{ value: "high", label: "High" }] as const,
      value: "high" as const,
      onChange,
      onReselect,
    };
    let container = await render(createElement(SegmentedControl<"high">, props));
    await click(findAllByTag(container, "BUTTON")[0]);
    expect(onChange).not.toHaveBeenCalled();
    expect(onReselect).toHaveBeenCalledExactlyOnceWith("high");
    onReselect.mockClear();
    container = await render(createElement(SegmentedControl<"high">, { ...props, disabled: true }));
    await click(findAllByTag(container, "BUTTON")[0]);
    expect(onReselect).not.toHaveBeenCalled();
  });

  it("marks a choice as pressed only when it holds a state", async () => {
    const container = await render(createElement("div", null,
      createElement(ChoiceButton, { selected: true }, "Yes"),
      createElement(ChoiceButton, null, "Answer"),
    ));
    const [selected, stateless] = findAllByTag(container, "BUTTON");
    expect(getReactProps(selected)?.["aria-pressed"]).toBe(true);
    expect(getReactProps(stateless)?.["aria-pressed"]).toBeUndefined();
  });

  it("keeps a disclosure closed until it is opened, and ties the row to what it opened", async () => {
    const onToggle = vi.fn();
    const container = await render(createElement(DisclosureRow, { label: "Skill loaded", detail: "personal", onToggle }, "Instructions"));
    const row = findAllByTag(container, "BUTTON")[0];
    expect(getReactProps(row)?.["aria-expanded"]).toBe(false);
    expect(container.textContent).not.toContain("Instructions");

    await click(row);
    const opened = findAllByTag(container, "BUTTON")[0];
    expect(getReactProps(opened)?.["aria-expanded"]).toBe(true);
    expect(container.textContent).toContain("Instructions");
    const content = findAllByTag(container, "DIV").find((element) => (
      getReactProps(element)?.id === getReactProps(opened)?.["aria-controls"]
    ));
    expect(content?.textContent).toBe("Instructions");
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("shows a disclosure with nothing to open as a plain line", async () => {
    const container = await render(createElement(DisclosureRow, { label: "Read file", disabled: true, defaultExpanded: true }, "Hidden"));
    const row = findAllByTag(container, "BUTTON")[0];
    expect(getReactProps(row)?.disabled).toBe(true);
    expect(getReactProps(row)?.["aria-expanded"]).toBeUndefined();
    expect(container.textContent).not.toContain("Hidden");
  });

  it("leaves a controlled disclosure to its owner", async () => {
    const onToggle = vi.fn();
    const container = await render(createElement(DisclosureRow, { label: "Worked for 2m", expanded: false, onToggle }, "Steps"));
    await click(findAllByTag(container, "BUTTON")[0]);
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(true);
    expect(container.textContent).not.toContain("Steps");
  });

  it("starts a native disclosure open only when asked", async () => {
    const container = await render(createElement("div", null,
      createElement(Details, { label: "MCP servers", detail: "2/2 connected", children: "healthy" }),
      createElement(Details, { label: "Recent tool failures", tone: "warning", open: true, children: "failed" }),
    ));
    const [closed, open] = findAllByTag(container, "DETAILS");
    expect(Boolean(getReactProps(closed)?.open)).toBe(false);
    expect(getReactProps(open)?.open).toBe(true);
    expect(findAllByTag(closed, "SUMMARY")[0]?.textContent).toBe("MCP servers2/2 connected");
  });

  it("labels a section for assistive tech and draws no box around it", async () => {
    const container = await render(createElement(Section, { label: "Sessions", count: 13, children: "rows" }));
    const section = findAllByTag(container, "SECTION")[0];
    const heading = findAllByTag(container, "H3")[0];
    expect(getReactProps(section)?.["aria-labelledby"]).toBe(getReactProps(heading)?.id);
    expect(heading.textContent).toBe("Sessions13");
    expect(getReactProps(section)?.className ?? "").not.toContain("border");
  });

  it("says an empty field once, quietly, in place of its value", async () => {
    const container = await render(createElement(FieldList, null,
      createElement(Field, { label: "Next action", empty: "No next action captured." }),
      createElement(Field, { label: "Workspace", mono: true }, "E:\\repo"),
    ));
    const [empty, filled] = findAllByTag(container, "DD");
    expect(empty.textContent).toBe("No next action captured.");
    expect(getReactProps(empty)?.className).toContain("text-text-faint");
    expect(filled.textContent).toBe("E:\\repo");
    expect(getReactProps(filled)?.className).toContain("font-mono");
  });

  it("joins the facts it is given and skips the ones it is not", async () => {
    const container = await render(createElement(MetaLine, { items: ["15h ago", false, undefined, "331 KB", ""] }));
    expect(container.textContent).toBe("15h ago·331 KB");
    const none = await render(createElement(MetaLine, { items: [false, null] }));
    expect(none.textContent).toBe("");
  });

  it("interrupts a screen reader for a failure and not for anything else", async () => {
    const container = await render(createElement("div", null,
      createElement(Notice, { tone: "danger" }, "Run failed"),
      createElement(Notice, { tone: "warning" }, "Interrupted"),
    ));
    const roles = findAllByTag(container, "DIV").map((element) => getReactProps(element)?.role).filter(Boolean);
    expect(roles).toEqual(["alert", "status"]);
  });

  it("marks the one bordered container so nesting can be found", async () => {
    const container = await render(createElement(Panel, null, "Question"));
    const panel = findAllByTag(container, "DIV").find((element) => getReactProps(element)?.["data-ds-panel"] !== undefined);
    expect(panel?.textContent).toBe("Question");
  });

  it("caps a count so it stays a badge", async () => {
    const container = await render(createElement("div", null,
      createElement(CountBadge, { count: 3 }),
      createElement(CountBadge, { count: 120, tone: "warning" }),
    ));
    const [small, large] = findAllByTag(container, "SPAN");
    expect(small.textContent).toBe("3");
    expect(large.textContent).toBe("99+");
    expect(getReactProps(large)?.className).toContain("bg-warning");
    expect(getReactProps(small)?.["aria-hidden"]).toBe("true");
  });

  it("draws a distinct glyph for every status and names it to assistive technology", async () => {
    const kinds = Object.keys(DS.status.tone) as Array<keyof typeof DS.status.tone>;
    const container = await render(createElement("div", null,
      ...kinds.map((kind) => createElement(StatusIcon, { key: kind, kind })),
    ));
    const icons = findAllByTag(container, "SPAN").filter((element) => element.getAttribute("data-status"));
    expect(icons.map((icon) => icon.getAttribute("data-status"))).toEqual(kinds);
    for (const icon of icons) {
      const kind = icon.getAttribute("data-status") as keyof typeof DS.status.tone;
      expect(icon.getAttribute("role")).toBe("img");
      expect(icon.getAttribute("aria-label")).toBe(STATUS_LABEL[kind]);
      expect(getReactProps(icon)?.className).toContain(DS.status.tone[kind]);
    }
    const shapes = icons.map((icon) => JSON.stringify(
      [...findAllByTag(icon, "circle"), ...findAllByTag(icon, "path")].map((shape) => {
        const { d, r, cx, cy, fill } = getReactProps(shape) ?? {};
        return { d, r, cx, cy, fill };
      }),
    ));
    expect(new Set(shapes).size).toBe(kinds.length);
  });

  it("hides a decorative status and stops the working spinner under reduced motion", async () => {
    const container = await render(createElement(StatusIcon, { kind: "working", decorative: true, label: "Ignored" }));
    const icon = findAllByTag(container, "SPAN")[0];
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.getAttribute("aria-label")).toBeNull();
    expect(getReactProps(findAllByTag(icon, "svg")[0])?.className).toContain("motion-reduce:animate-none");
  });

  it("draws identity as a square swatch and falls back to slate", async () => {
    const container = await render(createElement("div", null,
      createElement(IdentitySwatch, { color: "rose" }),
      createElement(IdentitySwatch, { color: "not-a-colour" }),
    ));
    const [rose, unknown] = findAllByTag(container, "SPAN");
    expect(getReactProps(rose)?.className).toContain("bg-identity-rose");
    expect(getReactProps(rose)?.className).not.toContain("rounded-full");
    expect(unknown.getAttribute("data-identity")).toBe("slate");
    expect(rose.getAttribute("aria-hidden")).toBe("true");
  });
});
