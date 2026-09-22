/** Frozen source reference retained when the dashboard-only system was retired. */
export interface ArchivedChecklistSource {
  sourceId: string; sourceType: "decision" | "alert" | "event"; activationId: string;
  title: string; lifecycle: string;
}
