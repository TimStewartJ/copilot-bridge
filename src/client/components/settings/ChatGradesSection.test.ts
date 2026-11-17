import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatGradesView } from "../../../shared/chat-grades.js";
import { createReactDomHarness, findAllByTag, getReactProps, waitUntilAct } from "../../test-react-harness";
import { installSelectAwareDomShim } from "../../test-dom-shim";

type ClickHandler = (event: unknown, item: { datum?: unknown } | null) => void;

const mocks = vi.hoisted(() => ({
  view: undefined as unknown,
  invalidateQueries: vi.fn(),
  startChatGrading: vi.fn(async () => ({ running: true, total: 2, done: 0 })),
  specs: [] as Array<Record<string, any>>,
  clicks: [] as ClickHandler[],
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQuery: () => ({ data: mocks.view, error: null, isLoading: false }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));
vi.mock("../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api")>(),
  startChatGrading: mocks.startChatGrading,
}));
vi.mock("vega-embed", () => ({
  default: async (_element: unknown, spec: Record<string, any>) => {
    mocks.specs.push(spec);
    return { view: { finalize: () => undefined, addEventListener: (_type: string, handler: ClickHandler) => { mocks.clicks.push(handler); } } };
  },
}));

const { ChatGradesSection } = await import("./ChatGradesSection");

const VIEW: ChatGradesView = {
  matching: 5,
  graded: 3,
  ungraded: 2,
  skipped: 0,
  models: [{ id: "model-a", name: "Model A", chats: 3 }, { id: "model-b", name: "Model B", chats: 2 }],
  run: { running: false, total: 0, done: 0 },
  report: {
    classifiers: [
      { classifier: "session_taxonomy", scope: "session", label: "l1", models: [
        { model: "model-a", chats: 2, units: 2, judgeTokens: 50, values: [{ value: "coding", count: 2 }] },
      ] },
      { classifier: "task_outcome", scope: "task", label: "outcome", models: [
        { model: "model-a", chats: 2, units: 3, judgeTokens: 100, values: [{ value: "succeeded", count: 2 }, { value: "failed", count: 1 }] },
        { model: "model-b", chats: 1, units: 1, judgeTokens: 40, values: [{ value: "succeeded", count: 1 }] },
      ] },
    ],
    chats: [
      { sessionId: "chat-1", title: "Fix the build", model: "model-a", date: "2026-03-04", labels: { task_outcome: ["succeeded", "failed"] } },
      { sessionId: "chat-2", title: "Plan the trip", model: "model-a", date: "2026-03-03", labels: { task_outcome: ["succeeded"] } },
      { sessionId: "chat-3", title: "Write the notes", model: "model-b", date: "2026-03-02", labels: { task_outcome: ["succeeded"] } },
    ],
  },
};

let harness: Awaited<ReturnType<typeof createReactDomHarness>> | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
  mocks.specs.length = 0;
  mocks.clicks.length = 0;
  vi.useRealTimers();
});

const links = (root: any) => findAllByTag(root, "a").map((element) => element.textContent);

describe("ChatGradesSection", () => {
  it("charts task outcomes per model, lists the chats behind a clicked segment, and grades with the filters", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 2, 28, 12));
    mocks.view = VIEW;
    harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    await harness.render(createElement(MemoryRouter, null, createElement(ChatGradesSection)));
    await waitUntilAct(harness.act, () => mocks.clicks.length > 0, { label: "chart rendered" });

    const spec = mocks.specs.at(-1)!;
    expect(spec.data.values.map((row: any) => [row.bar, row.value, row.count])).toEqual([
      ["Model A · 3 tasks", "succeeded", 2],
      ["Model A · 3 tasks", "failed", 1],
      ["Model B · 1 task", "succeeded", 1],
    ]);
    expect(links(harness.dom.container)).toEqual([]);

    await harness.act(async () => { mocks.clicks.at(-1)!({}, { datum: { model: "model-a", value: "succeeded" } }); });
    expect(links(harness.dom.container)).toEqual(["Fix the buildModel A · 2026-03-04", "Plan the tripModel A · 2026-03-03"]);
    await harness.act(async () => { mocks.clicks.at(-1)!({}, { datum: { model: "model-a", value: "succeeded" } }); });
    expect(links(harness.dom.container)).toEqual([]);

    // The grade control lists the outcome first and switches the chart to another grade.
    const gradeButtons = findAllByTag(harness.dom.container, "button").filter((element) => element.getAttribute("aria-pressed") !== null
      && ["Outcome", "Kind of work"].includes(element.textContent));
    expect(gradeButtons.map((element) => element.textContent)).toEqual(["Outcome", "Kind of work"]);
    await harness.act(async () => { getReactProps(gradeButtons[1]!)!.onClick(); });
    await waitUntilAct(harness.act, () => mocks.specs.at(-1)!.data.values.some((row: any) => row.value !== "succeeded" && row.value !== "failed"), { label: "chart switched" });

    const grade = findAllByTag(harness.dom.container, "button").find((element) => element.textContent === "Grade 2 chats")!;
    await harness.act(async () => { await getReactProps(grade)!.onClick(); });
    expect(mocks.startChatGrading).toHaveBeenCalledWith({ from: "2026-03-01", to: "2026-03-28", includeScheduled: false }, false);
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["chat-grades"] });
  });
});
