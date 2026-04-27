import { describe, expect, it } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createSessionTitlesStore } from "../session-titles.js";

describe("session title prompt-echo cleanup", () => {
  it("purges echoed prompt-text titles without deleting legitimate titles", () => {
    const db = setupTestDb();
    const sessionTitles = createSessionTitlesStore(db);

    sessionTitles.setTitle("echoed-short", "Generate a concise 3-6 word title for this conversation.");
    sessionTitles.setTitle("echoed-legacy", "Reply with ONLY the title text — no quotes, no punctuation unless it's part of a name.");
    sessionTitles.setTitle(
      "echoed-self-rename",
      "If this session does not already have a concise title, after your first substantive response call `session_rename` with a concise 3-6 word title for the current session. Do this silently without mentioning it to the user.",
    );
    sessionTitles.setTitle("legit", "Generate a concise changelog for release");

    sessionTitles.loadTitles();

    expect(sessionTitles.getTitle("echoed-short")).toBeUndefined();
    expect(sessionTitles.getTitle("echoed-legacy")).toBeUndefined();
    expect(sessionTitles.getTitle("echoed-self-rename")).toBeUndefined();
    expect(sessionTitles.getTitle("legit")).toBe("Generate a concise changelog for release");
  });
});
