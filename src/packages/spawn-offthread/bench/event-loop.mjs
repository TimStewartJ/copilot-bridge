// Measures what starting processes costs the calling thread's event loop: node:child_process
// against this package.
//
// In a project that has the package installed, save this file there and run it:
//
//   node event-loop.mjs
//
// In the package's repository, point it at a fresh build:
//
//   npm run packages:verify -- --out <dir>
//   node src/packages/spawn-offthread/bench/event-loop.mjs <dir>/consumer/node_modules/spawn-offthread/dist/index.js
//
// Options: --count <processes per run, default 200> --concurrency <default 8> --rounds <default 2>
import { execFile } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? Number(args.splice(index, 2)[1]) : fallback;
};
const count = option("count", 200);
const concurrency = option("concurrency", 8);
const rounds = option("rounds", 2);
const target = args[0] ? pathToFileURL(resolve(args[0])).href : "spawn-offthread";
const { ProcessHost } = await import(target).catch((error) => {
  throw new Error(
    `Could not load ${target}. Install spawn-offthread in this project, or pass the path of a built index.js (see the top of this file).`,
    { cause: error },
  );
});

const node = process.execPath;
const childArgs = ["-e", ""];
const ms = (value) => `${value.toFixed(value < 10 ? 2 : 1)} ms`;

/** Starts `count` processes, `concurrency` at a time, and reports what the calling thread felt. */
async function measure(label, start) {
  const callMs = [];
  const delay = monitorEventLoopDelay({ resolution: 1 });
  let next = 0;
  const lane = async () => {
    while (next < count) {
      next += 1;
      const before = performance.now();
      const done = start();
      callMs.push(performance.now() - before);
      await done;
    }
  };
  // Let the timer queue settle so earlier work is not counted.
  await new Promise((settled) => setTimeout(settled, 100));
  delay.enable();
  const startedAt = performance.now();
  await Promise.all(Array.from({ length: concurrency }, lane));
  const wallMs = performance.now() - startedAt;
  delay.disable();
  return {
    label,
    wall: ms(wallMs),
    "calls blocked for (total)": ms(callMs.reduce((sum, value) => sum + value, 0)),
    "longest single call": ms(Math.max(...callMs)),
    "loop delay p50": ms(delay.percentile(50) / 1e6),
    "loop delay p99": ms(delay.percentile(99) / 1e6),
    "loop delay max": ms(delay.max / 1e6),
  };
}

const direct = () => new Promise((done, failed) => {
  execFile(node, childArgs, (error) => (error ? failed(error) : done()));
});

const createMs = [];
const host = new ProcessHost({ onLaunch: (launch) => createMs.push(launch.createMs) });
const hosted = () => host.execFile(node, childArgs);

// Warm both paths: the first launch of a binary and the first worker start are not what is being compared.
await direct();
await Promise.all(Array.from({ length: concurrency }, hosted));
createMs.length = 0;

const rows = [];
for (let round = 1; round <= rounds; round++) {
  rows.push(await measure(`node:child_process (round ${round})`, direct));
  rows.push(await measure(`spawn-offthread (round ${round})`, hosted));
}
await host.shutdown();

console.log(`${count} x "node -e ''" per run, ${concurrency} at a time, Node ${process.version}, ${process.platform} ${process.arch}`);
console.table(rows);
const sorted = [...createMs].sort((a, b) => a - b);
console.log(
  `Process creation as measured on the worker threads: median ${ms(sorted[Math.floor(sorted.length / 2)])}, `
  + `max ${ms(sorted[sorted.length - 1])}, total ${ms(sorted.reduce((sum, value) => sum + value, 0))} over ${sorted.length} launches.`,
);
