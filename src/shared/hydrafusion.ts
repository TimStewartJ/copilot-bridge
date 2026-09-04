export const HYDRAFUSION_MODEL_ID = "hydrafusion";
export const HYDRAFUSION_MODEL_NAME = "HydraFusion (Research Preview)";

export function isHydraFusionModel(modelId: unknown): modelId is typeof HYDRAFUSION_MODEL_ID {
  return modelId === HYDRAFUSION_MODEL_ID;
}
