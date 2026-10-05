# In-tree packages

Code in this directory is useful outside the Bridge and is written to be published to npm by itself.
Each package lives here as source. The Bridge imports it by relative path
(`src/packages/<name>/src/index.js`), so there is one copy of the code, the Bridge's own build
compiles it, and installing or deploying the Bridge works exactly as before.

| Package | What it is | Where the Bridge uses it |
|---|---|---|
| [`spawn-offthread`](spawn-offthread/README.md) | `child_process` on worker threads, so creating a process never freezes the event loop | `src/server/process-host.ts` |
| [`@timstewartj/smart-turn`](smart-turn/README.md) | The Smart Turn v3 end-of-turn model from JavaScript: preprocessing and an ONNX Runtime wrapper | `src/server/voice/voice-engine-worker.ts` |
| [`voice-agent-text`](voice-agent-text/README.md) | What to say from a streamed LLM reply, how to chunk it for TTS, how to read an interruption | `src/server/voice/voice-text.ts` |

The folders are named after the packages, without the scope. A GitHub workflow releases a package
to npm when someone starts it, as described under
[Releasing a version](#releasing-a-version). `npm view <name> versions` shows what is published, and
the package's `CHANGELOG.md` what each version contains.

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
  package.json          name, version, exports of ./dist; "private", so npm refuses to publish the folder
  README.md  LICENSE
  CHANGELOG.md          one section per released version, and "Unreleased" for what changed since
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
npm run packages:release-check -- <folder name>   # can this package's version be released?
```

`check:pr` runs the per-package typecheck, and `npm test` runs the package tests. Build output
never lands in the repository, because the Bridge build stamp hashes `src/`: `scripts/packages.mjs`
writes to a temporary directory, or to an `--out` directory outside the repository.

## Releasing a version

What gets published is the tarball that `scripts/packages.mjs` builds, never a folder here. A
folder holds TypeScript source and no build, and its `package.json` stays `"private": true` so that
`npm publish` refuses it. The packed `package.json` leaves that flag out and records the commit it
was built from as `gitHead`.

The `Publish Package` workflow (`.github/workflows/publish-package.yml`) makes the release, and it
is the only way a version is released: nobody publishes one from a machine. The workflow publishes
the version itself. Nobody approves it on npm in between, so the version is public as soon as the
run has passed, and it can never be changed afterwards. No npm token is stored anywhere. In each
package's settings on npm, that workflow file of this repository is the package's trusted
publisher, allowed to publish, and access tokens cannot publish. Whoever can push to `master` and
start the workflow can therefore release a package: start it only when the owner asked for the
release.

1. In an ordinary change, set `version` in the package's `package.json` and move the entries under
   `## Unreleased` in its `CHANGELOG.md` to a `## <version>` section.
   `npm run packages:release-check -- <folder name>` says what is still missing.
2. Once that change is on `master`, start the workflow for the package: on GitHub under Actions, or
   with `gh workflow run publish-package.yml -f package=<folder name>`. It runs the package checks,
   builds the tarball, publishes it on npm with a provenance statement, and tags the commit
   `<folder name>-v<version>`. The summary of the run has the tarball's checksums.
3. Check the result: `npm view <name>@<version> dist.shasum` should print the shasum in the run's
   summary. The registry can take a minute to show a new version.

A dry run (`-f dry_run=true`) does everything but publish and tag. It fails unless npm accepts the
workflow as the package's trusted publisher, so run one after changing the workflow or a package's
settings on npm. It does not show whether the publisher may publish: npm checks that only when a
version arrives. It also works for a version that is already released.

A published version can never be changed or published again. To correct one, release the next
version and mark the bad one with `npm deprecate`.

Until 2026-10-05 the workflow could only stage a version, which the owner then approved on
npmjs.com. To go back to that: give each package's trusted publisher the permission to stage
without the permission to publish, and run `npm stage publish` in the workflow (it needs npm
11.15.0 or newer).

### The first version of a new package

The workflow cannot release it: npm lets a trusted publisher be added only to a package that
exists. This is the one release that does not go through the workflow. The owner of the npm account
publishes that version from a logged-in machine.

1. With the change on `master`, in a checkout of it with no local changes, run
   `npm run packages:verify` and then `npm run packages:pack -- --out <dir> <folder name>`. The
   directory must be outside the repository.
2. `npm publish <dir>/<file>.tgz`, with `--access public` for a package with a scope. npm asks for
   a second factor. That version has no provenance statement.
3. Tag the commit `<folder name>-v<version>` and push the tag.
4. Make the workflow the package's trusted publisher, allowed to publish, and keep access tokens
   from publishing. With npm 11.15.0 or newer:
   `npm trust github <name> --file publish-package.yml --repository TimStewartJ/copilot-bridge --allow-publish --allow-stage-publish`
   and `npm access set mfa=publish <name>`. Or on npmjs.com, in the package's settings: Trusted
   Publisher with "npm publish" among the allowed actions, and under Publishing access "Require
   two-factor authentication and disallow tokens". A trusted publisher cannot be edited; to change
   one, remove it and add it again.
5. Add the folder to the `package` options in the workflow.

The Bridge keeps importing the in-tree source after a release. If a package later moves to its
own repository, add it to the root `package.json` and change the one import path that uses it.
