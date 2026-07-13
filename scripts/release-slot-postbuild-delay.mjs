import { basename, dirname } from "node:path";

const cwd = process.cwd();
const name = basename(cwd);
const isTemporaryReleaseSlot =
  process.platform === "win32"
  && basename(dirname(cwd)).toLowerCase() === "release-slots"
  && name.startsWith(".")
  && name.endsWith(".tmp");

if (isTemporaryReleaseSlot) {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}
