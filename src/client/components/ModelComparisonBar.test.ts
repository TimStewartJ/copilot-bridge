import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelComparisonView } from "../../shared/model-ab-test.js";
import { createReactDomHarness, findAllByTag, getReactProps } from "../test-react-harness";

const mocks = vi.hoisted(() => ({ comparison: undefined as ModelComparisonView | undefined }));

vi.mock("../hooks/queries/useModelComparison", () => ({
  useModelComparisonQuery: () => ({ data: mocks.comparison, refetch: vi.fn() }),
}));
vi.mock("../hooks/queries/useModels", () => ({ useModelsQuery: () => ({ data: [] }) }));
vi.mock("../queryClient", () => ({ queryKeys: { modelComparison: (id: string) => ["model-comparison", id], sessionModel: (id: string) => ["session-model", id] } }));
vi.mock("../api", () => ({ combineModelComparison: vi.fn(), dismissModelComparison: vi.fn(), voteModelComparison: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn(), useParams: () => ({}) }));

const { default: ModelComparisonBar } = await import("./ModelComparisonBar");

const BASE: ModelComparisonView = { id: "pair-1", side: "x", otherSessionId: "twin-1", status: "running", votable: false, combinable: false };

let harness: Awaited<ReturnType<typeof createReactDomHarness>> | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

function yButton(container: unknown) {
  return findAllByTag(container, "BUTTON").find((button) => button.textContent === "Y");
}

describe("ModelComparisonBar", () => {
  it("keeps Y shut from X until both first replies are done", async () => {
    harness = await createReactDomHarness();
    mocks.comparison = BASE;
    await harness.render(createElement(ModelComparisonBar, { sessionId: "main-1", busy: false }));
    expect(getReactProps(yButton(harness.dom.container))?.disabled).toBe(true);

    mocks.comparison = { ...BASE, status: "judged", votable: true, combinable: true };
    await harness.render(createElement(ModelComparisonBar, { sessionId: "main-1", busy: false }));
    expect(getReactProps(yButton(harness.dom.container))?.disabled).toBe(false);
  });

  it("goes away once the pair is combined or dismissed", async () => {
    harness = await createReactDomHarness();
    for (const done of [{ combinedKeep: "y" as const, vote: "y" as const }, { dismissed: true }]) {
      mocks.comparison = { ...BASE, status: "judged", ...done };
      await harness.render(createElement(ModelComparisonBar, { sessionId: "main-1", busy: false }));
      expect(harness.dom.container.textContent).toBe("");
    }
  });
});
