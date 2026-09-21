import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDir } from "../../server/__tests__/helpers";
import {
  auditDesignSystem,
  DESIGN_RULES,
  findDesignViolations,
  formatDesignAuditResult,
} from "./audit";
import { DESIGN_AUDIT_PENDING } from "./audit-pending";

function ruleIds(source: string): string[] {
  return findDesignViolations("screen.tsx", source).map((violation) => violation.ruleId);
}

describe("design rules", () => {
  it("flags each retired pattern", () => {
    const cases: Array<[string, string]> = [
      ["legacy-tokens", 'import { UI } from "./shared/design-system";'],
      ["accent-fill", '<button className="rounded-md bg-accent px-3">Save</button>'],
      ["accent-fill", 'const selected = "bg-accent/10 text-text-primary";'],
      ["white-on-fill", '<span className="bg-success text-white">3</span>'],
      ["accent-outline", 'const selected = "border-accent text-text-primary";'],
      ["accent-outline", '<button className="focus-visible:ring-2 focus-visible:ring-accent/40" />'],
      ["tinted-box", '<div className="rounded-lg border border-warning/30 bg-warning/10 p-3" />'],
      ["state-pill", '<span className="rounded-full px-2 py-0.5 text-[10px]">Open</span>'],
      ["dashed-empty", '<div className="rounded-md border border-dashed border-border p-4" />'],
      ["in-page-shadow", '<div className="rounded-xl border border-border shadow-sm" />'],
      ["in-page-shadow", '<div className="shadow" />'],
      ["uppercase-label", '<div className="text-[11px] uppercase tracking-wide">Agents</div>'],
      ["uppercase-label", '<div className="uppercase">Agents</div>'],
    ];
    for (const [ruleId, source] of cases) {
      expect(ruleIds(source), source).toContain(ruleId);
    }
    expect(new Set(cases.map(([ruleId]) => ruleId))).toEqual(new Set(DESIGN_RULES.map((rule) => rule.id)));
  });

  it("leaves what the system itself uses alone", () => {
    const allowed = [
      '<span className="bg-accent-surface text-accent">New</span>',
      '<span className="h-1.5 w-1.5 rounded-full bg-success" />',
      '<button className="h-9 w-9 rounded-full border border-border" />',
      '<div className="shadow-black/10" />',
      '<div className="border-b border-border text-error" />',
      "const label = value.toUpperCase();",
      '<div className="border border-error/40 bg-bg-elevated" />',
      'const hint = "The uppercase letter has a shadow.";',
    ];
    for (const source of allowed) {
      expect(ruleIds(source), source).toEqual([]);
    }
  });

  it("reads code, not prose about code", () => {
    expect(ruleIds('// the old button used bg-accent and text-white')).toEqual([]);
    expect(ruleIds('/* a dashed box: border-dashed */\nconst a = 1;')).toEqual([]);
    expect(ruleIds('{/* shadow-sm was here */}')).toEqual([]);
  });

  it("does not take slashes inside strings or template text for comments", () => {
    expect(ruleIds('const href = "https://example.com"; const fill = "bg-accent";')).toEqual(["accent-fill"]);
    expect(ruleIds('const prefix = "words // still a string"; const fill = "bg-accent";')).toEqual(["accent-fill"]);
    expect(ruleIds('const path = `https://example.com/${id}`; const fill = "bg-accent";')).toEqual(["accent-fill"]);
  });

  it("checks multiline recipes as one recipe", () => {
    const content = 'const Box = <div className={`border-warning/30\n bg-warning/10`} />;';
    const found = findDesignViolations("screen.tsx", content);
    expect(found.map((violation) => violation.ruleId)).toEqual(["tinted-box"]);
    expect(found[0]?.lineNumber).toBe(1);
  });

  it("rejects nested panels, including aliases and conditional children", () => {
    expect(ruleIds('const Screen = <Panel><Section>{ready && <Panel>Nested</Panel>}</Section></Panel>;')).toEqual(["nested-panel"]);
    expect(ruleIds('import { Panel as Card } from "../design"; const Screen = <Card><Card /></Card>;')).toEqual(["nested-panel"]);
    expect(ruleIds('import { Panel as Card } from "../design/primitives.js"; const Screen = <Card><Card /></Card>;')).toEqual(["nested-panel"]);
    expect(ruleIds('const Screen = <Design.Panel><Design.Panel /></Design.Panel>;')).toEqual(["nested-panel"]);
    expect(ruleIds('const Screen = <><Panel>First</Panel><Panel>Second</Panel></>;')).toEqual([]);
    expect(ruleIds('const label = "<Panel><Panel>Example</Panel></Panel>";')).toEqual([]);
  });

  it("accepts an exception only when it says why", () => {
    const line = 'return "border-success/50 bg-success/10 text-success";';
    expect(ruleIds(`// design-audit-ignore-next-line: a diff is content\n${line}`)).toEqual([]);
    expect(ruleIds(`// design-audit-ignore-next-line:\n${line}`)).toEqual(["tinted-box"]);
    expect(ruleIds(`// design-audit-ignore-next-line\n${line}`)).toEqual(["tinted-box"]);
  });
});

describe("design audit", () => {
  let rootDir: string;
  let componentsDir: string;

  beforeEach(() => {
    rootDir = makeTestDir("design-audit");
    componentsDir = join(rootDir, "src", "client", "components");
    mkdirSync(componentsDir, { recursive: true });
    mkdirSync(join(rootDir, "src", "client", "design"), { recursive: true });
  });

  const dirty = 'export const a = <div className="border-dashed" />;\n';
  const clean = 'export const a = <div className="text-text-muted" />;\n';

  it("holds a file to the rules unless it is pending, and never the system or a test", () => {
    writeFileSync(join(componentsDir, "New.tsx"), dirty);
    writeFileSync(join(componentsDir, "Old.tsx"), dirty);
    writeFileSync(join(componentsDir, "Old.test.ts"), dirty);
    writeFileSync(join(rootDir, "src", "client", "design", "tokens.ts"), dirty);

    const result = auditDesignSystem(rootDir, ["src/client/components/Old.tsx"]);

    expect(result.scannedFiles).toBe(2);
    expect(result.violations.map((violation) => `${violation.file}:${violation.lineNumber}`)).toEqual([
      "src/client/components/New.tsx:1",
    ]);
    expect(result.stalePending).toEqual([]);
    const output = formatDesignAuditResult(result);
    expect(output).toContain("[dashed-empty] src/client/components/New.tsx:1");
    expect(output).toContain("Do not add the file to audit-pending.ts");
  });

  it("does not exempt a directory whose name merely starts with design", () => {
    const sibling = join(rootDir, "src", "client", "design-legacy");
    mkdirSync(sibling);
    writeFileSync(join(sibling, "Bad.tsx"), dirty);
    const result = auditDesignSystem(rootDir, []);
    expect(result.violations.map((violation) => violation.file)).toEqual(["src/client/design-legacy/Bad.tsx"]);
  });

  it("fails until a file that came clean, or is gone, leaves the pending list", () => {
    writeFileSync(join(componentsDir, "Migrated.tsx"), clean);

    const result = auditDesignSystem(rootDir, [
      "src/client/components/Migrated.tsx",
      "src/client/components/Deleted.tsx",
    ]);

    expect(result.violations).toEqual([]);
    expect(result.stalePending).toEqual([
      "src/client/components/Migrated.tsx",
      "src/client/components/Deleted.tsx",
    ]);
    expect(formatDesignAuditResult(result)).toContain("Remove them from the list");
  });

  it("passes on this repository", () => {
    const result = auditDesignSystem();
    expect(formatDesignAuditResult(result)).toContain("Design system audit passed");
    expect(result.pendingFiles).toBe(DESIGN_AUDIT_PENDING.length);
  });

  it("holds every runtime screen to the design system without grandfathered exceptions", () => {
    expect(DESIGN_AUDIT_PENDING).toEqual([]);
  });
});
