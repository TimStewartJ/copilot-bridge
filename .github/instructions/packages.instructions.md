---
applyTo: "src/packages/**"
description: "In-tree packages: code published to npm by itself; keep it free of the Bridge"
---

# In-tree packages

`src/packages/<name>/` holds code that is published to npm by itself. The Bridge imports it by relative path, so the same source is the Bridge's copy and the published one. Read `src/packages/README.md` for the layout, the commands, and how a package is released.

- A package imports nothing from the rest of the repository: only its own files and the npm packages its `package.json` declares. Write it for a stranger's project, not for the Bridge.
- A package with no `engines.node` in its `package.json` runs anywhere JavaScript does. Use no `node:` module and no DOM API in its source.
- Keep Bridge policy out. The process-wide host and its environment switch, the name "Bridge", settings and defaults that only make sense here: these stay in the Bridge module that wraps the package, and the package takes an option.
- The Bridge imports a package only as `src/packages/<name>/src/index.js`. If the Bridge needs something that is not exported, export it from the package's `index.ts` on purpose, and document it in the package README.
- Everything exported from `index.ts` is public API. Changing or removing it is a breaking change for people outside this repository once the package is released.
- Keep the package README true: it is the page a user of the published package reads. Numbers in it must come from a measurement you can repeat.
- Do not run `npm publish`, and do not change a package's name or version, unless the user asked for a release. `"private": true` stays in every package's `package.json`: a release is the built tarball, never the folder (see "Releasing a version" in `src/packages/README.md`).
- When you change a package's `src/`, add a line under `## Unreleased` at the top of its `CHANGELOG.md`. A released version can never be changed, and that section is what tells users what the next one brings.

## Tests and checks

- Unit tests are `test/*.test.ts`. They run in the `packages` Vitest project, without the Bridge's setup file, and may import only the package, `vitest`, and Node built-ins. Put shared test code in `test/` beside them.
- Tests that start real processes are `test/*.native.test.ts` and run in the `native` project.
- `test/smoke.mjs` imports the package by name. `npm run packages:verify` runs it against the packed tarball installed in a scratch project: update it when the public surface changes.
- Run `npm run check:packages` while implementing, and `npm run packages:verify` before saying a package works for a consumer.
- `src/server/__tests__/in-tree-packages.test.ts` enforces the import rules and the layout.
- Never write build output under `src/`: the Bridge build stamp hashes that tree. `scripts/packages.mjs` builds into a temporary directory, or an `--out` directory outside the repository.
