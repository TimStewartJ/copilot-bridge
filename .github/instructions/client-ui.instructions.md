---
applyTo: "src/client/**"
description: "Client UI: build screens from the design system in src/client/design"
---

# Client UI

- Build every screen from `src/client/design/`. Read `src/client/design/README.md` before writing or changing UI. It holds the rules (surface levels, contrast, status, shadows, touch targets) and says which primitive to use for what.
- Use the primitives in `primitives.tsx` and the class recipes in `tokens.ts` (`DS`, `cx`). Do not hand-write a class string for something the system already has.
- When something is missing and a second screen will need it, add it to the design folder with a comment that says what it is for. Do not grow a private `Section`, `Card`, `Chip`, or button style inside a component.
- `npm run test:design-audit` runs in `check:fast`, `check:client`, `check:pr`, and CI, and blocks the retired patterns. `npx tsx src/client/design/audit.ts --explain <file>` explains a violation. Never add a file to `src/client/design/audit-pending.ts`; a regression test keeps it empty.
- `// design-audit-ignore-next-line: <reason>` is for content with conventions of its own, such as a diff. It is not for a screen that is hard to restyle.
- Check UI work in both themes and at phone width, on the real screen, before calling it done.
