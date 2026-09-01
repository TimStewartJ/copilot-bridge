import { describe, expect, it } from "vitest";
import { matchesAdoProvider, parseAdoWorkReferenceUrl } from "./ado-work-reference.js";

describe("parseAdoWorkReferenceUrl", () => {
  it("parses visualstudio.com work-item links", () => {
    expect(parseAdoWorkReferenceUrl(
      "https://exampleorg.visualstudio.com/One/_workitems/edit/30000015",
    )).toEqual({
      kind: "workItem",
      org: "exampleorg",
      project: "One",
      workItemId: "30000015",
    });
  });

  it("parses dev.azure.com pull-request links with encoded repository names", () => {
    expect(parseAdoWorkReferenceUrl(
      "https://dev.azure.com/exampleorg/One/_git/Repo%20Name/pullrequest/10000003?_a=overview",
    )).toEqual({
      kind: "pullRequest",
      org: "exampleorg",
      project: "One",
      repoId: "Repo Name",
      repoName: "Repo Name",
      prId: 10000003,
    });
  });

  it("accepts legacy DefaultCollection links", () => {
    expect(parseAdoWorkReferenceUrl(
      "https://exampleorg.visualstudio.com/DefaultCollection/One/_workitems/edit/42",
    )).toMatchObject({
      kind: "workItem",
      project: "One",
      workItemId: "42",
    });
  });

  it("rejects unrelated and malformed links", () => {
    expect(parseAdoWorkReferenceUrl("https://example.com/One/_workitems/edit/42")).toBeNull();
    expect(parseAdoWorkReferenceUrl("http://exampleorg.visualstudio.com/One/_workitems/edit/42")).toBeNull();
    expect(parseAdoWorkReferenceUrl("https://exampleorg.visualstudio.com/One/_workitems/edit/not-a-number")).toBeNull();
  });
});

describe("matchesAdoProvider", () => {
  it("matches configured organization and project case-insensitively", () => {
    const reference = parseAdoWorkReferenceUrl(
      "https://dev.azure.com/EXAMPLEORG/one/_workitems/edit/42",
    );
    expect(reference).not.toBeNull();
    expect(matchesAdoProvider(reference!, { org: "exampleorg", project: "One" })).toBe(true);
  });
});
