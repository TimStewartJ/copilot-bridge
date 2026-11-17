import { describe, expect, it } from "vitest";
import { findAnyUsage, isProductionSource } from "../any-audit.js";

describe("any audit", () => {
  it.each([
    ["const a = value as any;", 1, 0],
    ["const a = value as (any);", 1, 0],
    ["const a = <any>value;", 1, 0],
    ["const rows = stmt.all() as any[];", 1, 0],
    ["const a = value as Record<string, any>;", 1, 0],
    ["function f(x: any): any[] { return [x]; }", 2, 0],
    ["try {} catch (err: any) {}", 1, 0],
    ["type Fn = (...args: any[]) => unknown;", 1, 0],
    ["const a = value as unknown as Row;", 0, 1],
    ["const a = (value as unknown) as Row;", 0, 1],
    ["const a: string = `as any`; // as any", 0, 0],
  ])("%s", (code, uses, doubleCasts) => {
    const usage = findAnyUsage("example.ts", code);
    expect([usage.uses.length, usage.doubleCasts]).toEqual([uses, doubleCasts]);
  });

  it.each([
    ["src/server/task-store.ts", true],
    ["src/client/App.tsx", true],
    ["src/packages/spawn-offthread/src/host.ts", true],
    ["src/server/__tests__/task-store.test.ts", false],
    ["src/server/task-store.test.ts", false],
    ["src/test-support/vitest-setup.ts", false],
    ["src/integration/scenario-world.ts", false],
    ["src/packages/spawn-offthread/test/support.ts", false],
    ["src/client/test-react-harness.ts", false],
    ["src/client/browser-live/test-live-fakes.ts", false],
    ["src/shared/types.d.ts", false],
  ])("reads %s: %s", (path, expected) => {
    expect(isProductionSource(path)).toBe(expected);
  });
});
