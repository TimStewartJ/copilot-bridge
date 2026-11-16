import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createReactDomHarness, findAllByTag, getReactProps, waitUntilAct } from "../test-react-harness";
import { installDialogDom } from "../test-dialog-harness";

const apiMocks = vi.hoisted(() => ({
  createTrigger: vi.fn(async (input: unknown) => ({ id: "created", ...(input as object) })),
  updateTrigger: vi.fn(),
  fetchServerTimezone: vi.fn(async () => "Europe/Paris"),
}));

vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), ...apiMocks }));
vi.mock("../hooks/queries/useModels", () => ({
  useModelsQuery: () => ({ data: [] }),
  useModelRolesQuery: () => ({ data: undefined }),
}));
vi.mock("../hooks/queries/usePlaybooks", () => ({ usePlaybooksQuery: () => ({ data: [] }) }));

const { default: TriggerDetailSheet } = await import("./TriggerDetailSheet");

describe("TriggerDetailSheet", () => {
  it("creates a trigger from the form with the server time zone as the cron default", async () => {
    const onSaved = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const harness = await createReactDomHarness({ installDom: installDialogDom });
    try {
      await harness.render(createElement(QueryClientProvider, { client: queryClient }, createElement(TriggerDetailSheet, {
        trigger: null,
        taskId: "task-1",
        mode: "create",
        onClose: vi.fn(),
        onSwitchToEdit: vi.fn(),
        onSwitchToView: vi.fn(),
        onAction: vi.fn(),
        onSaved,
      })));
      const zone = () => findAllByTag(harness.dom.container, "INPUT").find((input) => getReactProps(input)?.["aria-label"] === "Time zone");
      await waitUntilAct(harness.act, () => getReactProps(zone())?.value === "Europe/Paris", { label: "server time zone" });

      const prompt = findAllByTag(harness.dom.container, "TEXTAREA")[0];
      await harness.act(async () => { getReactProps(prompt)?.onChange?.({ target: { value: "Summarize the week" } }); });
      const form = findAllByTag(harness.dom.container, "FORM")[0];
      await harness.act(async () => { getReactProps(form)?.onSubmit?.({ preventDefault() {} }); });

      expect(apiMocks.createTrigger).toHaveBeenCalledWith({
        prompt: "Summarize the week",
        then: "new_chat",
        taskId: "task-1",
        cron: "0 8 * * 1-5",
        timezone: "Europe/Paris",
      });
      await waitUntilAct(harness.act, () => onSaved.mock.calls.length > 0, { label: "saved" });
      expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "created" }));
    } finally {
      await harness.cleanup();
      queryClient.clear();
    }
  });
});
