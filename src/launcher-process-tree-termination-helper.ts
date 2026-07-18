import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isProcessTreeTerminationRequest,
  PROCESS_TREE_TERMINATION_ACK,
  PROCESS_TREE_TERMINATION_HELPER_MODE,
  PROCESS_TREE_TERMINATION_RESULT,
  runProcessTreeTerminationFixpoint,
  type ProcessTreeTerminationResponse,
} from "./launcher-process-tree-termination.js";
import { deadlineFromUnixMs } from "./server/deadline.js";
import { PROCESS_TREE_TERMINATION_BUDGET_MS } from "./server/platform.js";

export function runProcessTreeTerminationHelper(): void {
  process.once("message", (message: unknown) => {
    if (!isProcessTreeTerminationRequest(message)) {
      process.exitCode = 2;
      process.disconnect?.();
      return;
    }

    const deadline = deadlineFromUnixMs(
      message.deadlineUnixMs,
      PROCESS_TREE_TERMINATION_BUDGET_MS,
    );
    void runProcessTreeTerminationFixpoint(message.root, deadline).then(
      (response) => sendResponse(response),
      (error) => sendResponse({
        type: PROCESS_TREE_TERMINATION_RESULT,
        attempts: 0,
        result: {
          ok: false,
          status: "snapshot-unavailable",
          root: message.root,
          error: error instanceof Error ? error.message : String(error),
        },
      }),
    );
  });
}

function sendResponse(response: ProcessTreeTerminationResponse): void {
  if (typeof process.send !== "function") {
    process.exitCode = response.result.ok ? 0 : 1;
    return;
  }
  const finish = () => {
    process.exitCode = response.result.ok ? 0 : 1;
    if (process.connected) process.disconnect();
  };
  const acknowledgementTimeout = setTimeout(finish, 1_000);
  const onAcknowledgement = (message: unknown) => {
    if (
      !message
      || typeof message !== "object"
      || (message as { type?: unknown }).type !== PROCESS_TREE_TERMINATION_ACK
    ) return;
    clearTimeout(acknowledgementTimeout);
    process.off("message", onAcknowledgement);
    finish();
  };
  process.on("message", onAcknowledgement);
  process.send(response, (error) => {
    if (error) {
      clearTimeout(acknowledgementTimeout);
      process.off("message", onAcknowledgement);
      finish();
    }
  });
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (
  process.argv.includes(PROCESS_TREE_TERMINATION_HELPER_MODE)
  || entryPath === resolve(fileURLToPath(import.meta.url))
) {
  runProcessTreeTerminationHelper();
}
