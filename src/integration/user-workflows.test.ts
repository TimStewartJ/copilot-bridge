import { afterEach, describe, it, vi } from "vitest";
import { attentionScenarios } from "./scenarios-attention.js";
import { knowledgeScenarios } from "./scenarios-knowledge.js";
import { operationScenarios } from "./scenarios-operations.js";
import { taskScenarios } from "./scenarios-task.js";
import { createScenarioWorld } from "./scenario-world.js";

const scenarios = [
  ...taskScenarios,
  ...attentionScenarios,
  ...knowledgeScenarios,
  ...operationScenarios,
];

const ids = scenarios.map((scenario) => scenario.id);
if (new Set(ids).size !== ids.length) {
  throw new Error("Integration scenario catalog contains duplicate IDs");
}
afterEach(() => {
  vi.restoreAllMocks();
});

describe("critical multi-boundary user workflows", () => {
  it.each(scenarios)("$id $title", async (scenario) => {
    const world = createScenarioWorld();
    await scenario.run(world);
  });
});
