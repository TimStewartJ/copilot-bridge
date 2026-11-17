import { writeFileSync } from "node:fs";
import type { Reporter, TestRunEndReason, Vitest } from "vitest/node";

/** Writes unhandled errors and end reason, which the JSON report omits, to `<report>.run.json`. */
export default class RunSummaryReporter implements Reporter {
  private summaryPath: string | undefined;

  onInit(vitest: Vitest): void {
    const outputFile = vitest.config.outputFile;
    const jsonPath = typeof outputFile === "string" ? outputFile : outputFile?.json;
    this.summaryPath = jsonPath ? `${jsonPath}.run.json` : undefined;
  }

  onTestRunEnd(_modules: unknown, unhandledErrors: ReadonlyArray<unknown>, reason: TestRunEndReason): void {
    if (this.summaryPath) {
      writeFileSync(this.summaryPath, JSON.stringify({ unhandledErrors: unhandledErrors.length, reason }));
    }
  }
}
