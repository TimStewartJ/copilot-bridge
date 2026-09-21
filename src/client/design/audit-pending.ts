/**
 * Screens written before the design system existed and not yet moved onto it. The design audit
 * (audit.ts) skips the rules for these files and holds every other client file to them.
 *
 * This list only shrinks. Do not add a file to it: a new screen, or a screen being changed, is
 * built from src/client/design. When a file here stops breaking the rules the audit fails until it
 * is taken off the list, so that it stays clean from then on.
 *
 * To see what a file still breaks: `npx tsx src/client/design/audit.ts --explain <file>`.
 */
export const DESIGN_AUDIT_PENDING: ReadonlyArray<string> = [];
