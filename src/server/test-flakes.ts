import { join } from "node:path";

/** Set by validation gates: src/test-support/run-tests.ts then reruns failures and logs flakes. */
export const TEST_FLAKE_LEDGER_ENV = "BRIDGE_TEST_FLAKE_LEDGER";

/** Production checkout; a flake is excused only if the change since its HEAD misses the test. */
export const TEST_FLAKE_BASE_ENV = "BRIDGE_TEST_FLAKE_BASE_CHECKOUT";

/** Env a validation gate passes so the test runner records and judges flakes. */
export function testFlakeGateEnv(dataDir: string, baseCheckout?: string): NodeJS.ProcessEnv {
  return {
    [TEST_FLAKE_LEDGER_ENV]: testFlakeLedgerPath(dataDir),
    ...(baseCheckout ? { [TEST_FLAKE_BASE_ENV]: baseCheckout } : {}),
  };
}

export function testFlakeLedgerPath(dataDir: string): string {
  return join(dataDir, "test-flakes.jsonl");
}

/** One line of the ledger: a test file that failed and then passed on the rerun. */
export interface TestFlakeRecord {
  at: string;
  cwd: string;
  commit?: string;
  /** Repository-relative, forward slashes. */
  file: string;
  failedTests: string[];
  /** True when the gate passed because of the rerun. */
  excused: boolean;
  /** Why a flake still failed the gate. */
  blockedBecause?: "changed" | "no-base";
}

export interface FlakeDecisionInput {
  /** Files that failed the first run. */
  failed: readonly string[];
  /** Files that failed the rerun. */
  rerunFailed: ReadonlySet<string>;
  /** Test files the change reaches; undefined when that could not be worked out. */
  affected?: ReadonlySet<string>;
}

export interface FlakeDecision {
  pass: boolean;
  flakes: Array<{ file: string; excused: boolean; blockedBecause?: "changed" | "no-base" }>;
}

export function decideFlakeOutcome(input: FlakeDecisionInput): FlakeDecision {
  const flakes = input.failed
    .filter((file) => !input.rerunFailed.has(file))
    .map((file) => {
      if (!input.affected) return { file, excused: false, blockedBecause: "no-base" as const };
      if (input.affected.has(file)) return { file, excused: false, blockedBecause: "changed" as const };
      return { file, excused: true };
    });
  const pass = input.failed.length > 0
    && flakes.length === input.failed.length
    && flakes.every((flake) => flake.excused);
  return { pass, flakes };
}
