# In-tree packages

Code in this directory is useful outside the Bridge and is written to be published to npm by itself.
Each package lives here as source. The Bridge imports it by relative path
(`src/packages/<name>/src/index.js`), so there is one copy of the code, the Bridge's own build
compiles it, and installing or deploying the Bridge works exactly as before.

| Package | What it is | Where the Bridge uses it |
|---|---|---|
| [`spawn-offthread`](spawn-offthread/README.md) | `child_process` on worker threads, so creating a process never freezes the event loop | `src/server/process-host.ts` |
| [`smart-turn-js`](smart-turn-js/README.md) | The Smart Turn v3 end-of-turn model from JavaScript: preprocessing and an ONNX Runtime wrapper | `src/server/voice/voice-engine-worker.ts` |
| [`voice-agent-text`](voice-agent-text/README.md) | What to say from a streamed LLM reply, how to chunk it for TTS, how to read an interruption | `src/server/voice/voice-text.ts` |

Nothing here is published yet. Every `package.json` is marked `"private": true`, which makes
`npm publish` refuse. The three names were unclaimed on npm on 2026-10-02 and are placeholders
until a first release.

## Rules

A package has to stay publishable by itself. `src/server/__tests__/in-tree-packages.test.ts` walks
the real files and fails when one of these breaks:

- A package imports nothing from the rest of the repository: only its own files, and the npm
  packages its `package.json` declares.
- A package with no `engines.node` in its `package.json` runs anywhere JavaScript does. Its source
  uses no `node:` module, and its `tsconfig.json` loads neither Node nor DOM types.
- The Bridge imports a package only as `src/packages/<name>/src/index.js`, the same surface the
  published build has. Swapping the in-tree copy for the npm one is then a change of import path.

What belongs to the Bridge stays in the Bridge: the process-wide host and the `BRIDGE_PROCESS_HOST`
switch are in `src/server/process-host.ts`, and the name "Bridge" and its voice commands are in
`src/server/voice/voice-text.ts`. A package gets an option instead.

## Layout

```text
src/packages/<name>/
  package.json          name, version, exports of ./dist; "private" until first release
  README.md  LICENSE
  tsconfig.json         type-checks src/ and test/ with the package's own settings; never emits
  tsconfig.build.json   src/ only; scripts/packages.mjs turns emit on and points it outside the repo
  src/index.ts          the public surface
  test/*.test.ts        Vitest, in the "packages" project, without the Bridge's setup file
  test/*.native.test.ts real processes; runs in the "native" project
  test/smoke.mjs        imports the package by name; run against the packed tarball
```

## Commands

```powershell
npm run check:packages    # server typecheck, per-package typecheck, package unit tests
npm run packages:verify   # build, pack, install the tarballs in a scratch project, run each smoke test
npm run packages:pack -- --out E:\Temp\packages   # just the tarballs
```

`check:pr` runs the per-package typecheck, and `npm test` runs the package tests. Build output
never lands in the repository, because the Bridge build stamp hashes `src/`: `scripts/packages.mjs`
writes to a temporary directory, or to an `--out` directory outside the repository.

## Publishing a package

1. Settle the name and scope, and set them in the package's `package.json` and README.
2. Run `npm run packages:verify`.
3. Remove `"private": true`, bump `version`, and add a `CHANGELOG.md` entry.
4. `npm run packages:pack -- --out <dir> <name>`, then `npm publish <dir>/<name>-<version>.tgz`.

The Bridge can keep importing the in-tree source after a release. If a package later moves to its
own repository, add it to the root `package.json` and change the one import path that uses it.
