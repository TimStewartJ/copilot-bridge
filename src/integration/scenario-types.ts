import type { ScenarioWorld } from "./scenario-world.js";

export interface IntegrationScenario {
  id: string;
  title: string;
  run(world: ScenarioWorld): Promise<void>;
}
