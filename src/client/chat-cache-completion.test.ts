import { describe, expect, it } from "vitest";
import type { ChatEntry } from "./api";
import { appendLiveEntries } from "./chat-cache";

function createCompletionEntry(id: string, content = id): ChatEntry {
  return {
    id,
    type: "completion",
    content,
    completion: {
      content,
      title: "Task complete",
      status: "success",
      sourceEventType: "session.task_complete",
    },
  };
}

describe("appendLiveEntries completion entries", () => {
  it("skips duplicate terminal completion entries on reconnect", () => {
    const previousEntries = [createCompletionEntry("entry-1", "All done")];

    const merged = appendLiveEntries(previousEntries, [
      createCompletionEntry("stream-1", "All done"),
    ]);

    expect(merged).toEqual(previousEntries);
  });
});
