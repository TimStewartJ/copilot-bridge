import { afterEach, describe, it, vi } from "vitest";
import * as scheduler from "../server/scheduler.js";
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
if (scenarios.length !== 100) {
  throw new Error(`Integration scenario catalog must contain exactly 100 scenarios; found ${scenarios.length}`);
}
if (new Set(ids).size !== ids.length) {
  throw new Error("Integration scenario catalog contains duplicate IDs");
}
afterEach(() => {
  if (scheduler.isInitialized()) scheduler.shutdown();
  vi.restoreAllMocks();
});

describe("critical multi-boundary user workflows", () => {
  it.each(scenarios)("$id $title", async (scenario) => {
    const world = createScenarioWorld();
    await scenario.run(world);
  });
});
