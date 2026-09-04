import { describe, expect, it } from "vitest";
import {
  HYDRAFUSION_MODEL_ID,
  isHydraFusionModel,
} from "./hydrafusion.js";

describe("HydraFusion capability helpers", () => {
  it("recognizes only the synthetic HydraFusion model id", () => {
    expect(isHydraFusionModel(HYDRAFUSION_MODEL_ID)).toBe(true);
    expect(isHydraFusionModel("HydraFusion")).toBe(false);
    expect(isHydraFusionModel(undefined)).toBe(false);
  });
});
