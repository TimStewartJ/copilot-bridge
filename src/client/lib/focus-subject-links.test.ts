import { describe, expect, it } from "vitest";
import { readFocusSubjectLink, setFocusSubjectLink } from "./focus-subject-links";

describe("Focus subject link parameters", () => {
  it.each(["", "?view=quiet&task=task-1", "?focusObject=record-1&episodeId=activation-1"])(
    "does not interpret unrelated parameters as a subject: %s",
    (search) => {
      expect(readFocusSubjectLink(search)).toEqual({ target: null, error: null });
    },
  );

  it("decodes the exact object and activation once without consuming unrelated parameters", () => {
    expect(readFocusSubjectLink("?view=quiet&focus=record%2Fone%2Btwo%26three&episode=old%252Fepisode&view=all")).toEqual({
      target: { objectId: "record/one+two&three", activationId: "old%2Fepisode" },
      error: null,
    });
  });

  it("supports an object-only link without inventing an activation", () => {
    expect(readFocusSubjectLink("?focus=record-older-than-first-page")).toEqual({
      target: { objectId: "record-older-than-first-page" },
      error: null,
    });
    expect(readFocusSubjectLink("?focus=%20record-1%20&episode=%20activation-1%20")).toEqual({
      target: { objectId: "record-1", activationId: "activation-1" },
      error: null,
    });
  });

  it.each([
    "?focus",
    "?focus=",
    "?focus=%20%09",
    "?episode=activation-1",
    "?episode=",
    "?focus=&episode=activation-1",
    "?focus=record-1&episode",
    "?focus=record-1&episode=",
    "?focus=record-1&episode=%20%09",
    "?focus=record-1&focus=record-2",
    "?focus=record-1&focus=record-1",
    "?focus=&focus=record-1",
    "?focus=record-1&%66ocus=record-1",
    "?focus=record-1&episode=activation-1&episode=activation-2",
    "?focus=record-1&episode=activation-1&episode=activation-1",
    "?focus=record-1&episode=&episode=activation-1",
  ])("rejects an empty or ambiguous subject rather than choosing a record: %s", (search) => {
    const result = readFocusSubjectLink(search);
    expect(result.target).toBeNull();
    expect(result.error).toContain("unambiguously");
    expect(result.error).toContain("No record was changed");
  });

  it("replaces all owned parameters while preserving unrelated values and their multiplicity", () => {
    const original = new URLSearchParams("view=quiet&focus=bad&tag=one&episode=old&focus=duplicate&tag=two&episode=duplicate&empty=");
    const before = original.toString();
    const target = { objectId: "object/with + & unicode ✓", activationId: "retained/episode?x=1" };
    const result = setFocusSubjectLink(original, target);

    expect(result).not.toBe(original);
    expect(original.toString()).toBe(before);
    expect([...result]).toEqual([
      ["view", "quiet"], ["tag", "one"], ["tag", "two"], ["empty", ""],
      ["focus", target.objectId], ["episode", target.activationId],
    ]);
    expect(readFocusSubjectLink(`?${result}`)).toEqual({ target, error: null });
  });

  it("drops a previous activation when replacing an episode link with an object-only lookup", () => {
    const result = setFocusSubjectLink("?view=history&focus=old-object&episode=old-activation", { objectId: "new-object" });
    expect([...result]).toEqual([["view", "history"], ["focus", "new-object"]]);
    expect(readFocusSubjectLink(result.toString())).toEqual({ target: { objectId: "new-object" }, error: null });
  });

  it("closing an invalid link removes only the owned keys, including duplicate occurrences", () => {
    const original = new URLSearchParams("focus=one&tag=one&episode=&tag=two&focus=two&episode=other&focusTab=history&empty=");
    const before = original.toString();
    const result = setFocusSubjectLink(original, null);
    expect([...result]).toEqual([["tag", "one"], ["tag", "two"], ["focusTab", "history"], ["empty", ""]]);
    expect(original.toString()).toBe(before);
    expect(readFocusSubjectLink(result.toString())).toEqual({ target: null, error: null });
  });

  it.each(["?focus=record-1&episode=activation-1", "?focus=record-1", "?episode=orphan"])(
    "does not leave an empty query marker after closing %s",
    (search) => {
      expect(setFocusSubjectLink(search, null).toString()).toBe("");
    },
  );
});
