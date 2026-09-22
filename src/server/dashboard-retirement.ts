import { getProcessHost, resolveWorkerEntry } from "./process-host.js";

export async function prepareDashboardRetirement(dataDir: string): Promise<void> {
  const { entry, execArgv } = resolveWorkerEntry("dashboard-retirement-worker", import.meta.url);
  const result = await getProcessHost().execFile(process.execPath, [...execArgv ?? [], entry, dataDir],
    { timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true });
  console.info("[dashboard-retirement]", result.stdout.trim());
}
