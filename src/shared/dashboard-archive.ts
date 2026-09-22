export interface ArchivedDashboardObject {
  id: string; type: string; title: string; status: string | null; lifecycle: string | null;
  taskId: string | null; taskTitle: string | null; interventionBy: string | null; createdAt: string | null;
}
export interface DashboardArchivePage {
  items: ArchivedDashboardObject[]; total: number; offset: number; hasMore: boolean;
  openConcerns: number; retiredAt?: string;
}
export interface DashboardArchiveDetail extends ArchivedDashboardObject {
  body: string | null;
  records: Array<{ table: string; value: Record<string, unknown> }>;
  recordsTotal: number; recordOffset: number; hasMoreRecords: boolean;
}
