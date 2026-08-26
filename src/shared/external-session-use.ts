export type ExternalSessionUseStatus = "available" | "unsupported" | "unavailable";

export interface ExternalSessionUseSnapshot {
  status: ExternalSessionUseStatus;
  inUse: string[];
  checkedAt: string;
}
