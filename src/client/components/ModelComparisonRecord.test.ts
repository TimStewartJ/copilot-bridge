import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelComparisonView } from "../../shared/model-ab-test.js";
import { createReactDomHarness, findAllByTag, getReactProps } from "../test-react-harness";

const mocks = vi.hoisted(() => ({ comparison: undefined as ModelComparisonView | undefined }));

vi.mock("../hooks/queries/useModelComparison", () => ({ useModelComparisonQuery: () => ({ data: mocks.comparison }) }));
vi.mock("../hooks/queries/useModels", () => ({ useModelsQuery: () => ({ data: [] }) }));
vi.mock("react-router-dom", () => ({
  useParams: () => ({}),
  Link: ({ to, children }: { to: string; children: ReactNode }) => createElement("a", { href: to }, children),
}));

const { default: ModelComparisonRecord } = await import("./ModelComparisonRecord");

const REVEALED: ModelComparisonView["revealed"] = { x: { model: "model-a" }, y: { model: "model-b" } };
const BASE: ModelComparisonView = {
  id: "pair-1", side: "y", otherSessionId: "main-1", status: "judged", votable: false, combinable: false, taskId: "task-1",
};

let harness: Awaited<ReturnType<typeof createReactDomHarness>> | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe("ModelComparisonRecord", () => {
  it("stays out of the panel while the pair is undecided", async () => {
    harness = await createReactDomHarness();
    mocks.comparison = { ...BASE, votable: true, combinable: true };
    await harness.render(createElement(ModelComparisonRecord, { sessionId: "twin-1" }));
    expect(harness.dom.container.textContent).toBe("");

    mocks.comparison = { ...BASE, vote: "x", revealed: REVEALED };
    await harness.render(createElement(ModelComparisonRecord, { sessionId: "twin-1" }));
    expect(harness.dom.container.textContent).toBe("");
  });

  it("links to the other chat once the pair is combined or dismissed", async () => {
    harness = await createReactDomHarness();
    for (const done of [{ combinedKeep: "x" as const }, { dismissed: true }]) {
      mocks.comparison = { ...BASE, revealed: REVEALED, ...done };
      await harness.render(createElement(ModelComparisonRecord, { sessionId: "twin-1" }));
      const links = findAllByTag(harness.dom.container, "A").map((link) => getReactProps(link)?.href);
      expect(links).toEqual(["/tasks/task-1/sessions/main-1"]);
    }
  });
});
