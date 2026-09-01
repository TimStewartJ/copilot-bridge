import { describe, expect, it } from "vitest";
import { matchesAdoProvider, parseAdoWorkReferenceUrl } from "./ado-work-reference.js";

describe("parseAdoWorkReferenceUrl", () => {
  it("parses visualstudio.com work-item links", () => {
    expect(parseAdoWorkReferenceUrl(
      "https://msazure.visualstudio.com/One/_workitems/edit/37655015",
    )).toEqual({
      kind: "workItem",
      org: "msazure",
      project: "One",
      workItemId: "37655015",
    });
  });

  it("parses dev.azure.com pull-request links with encoded repository names", () => {
    expect(parseAdoWorkReferenceUrl(
      "https://dev.azure.com/msazure/One/_git/Repo%20Name/pullrequest/15509721?_a=overview",
    )).toEqual({
      kind: "pullRequest",
      org: "msazure",
      project: "One",
      repoId: "Repo Name",
      repoName: "Repo Name",
      prId: 15509721,
    });
  });

  it("accepts legacy DefaultCollection links", () => {
    expect(parseAdoWorkReferenceUrl(
      "https://msazure.visualstudio.com/DefaultCollection/One/_workitems/edit/42",
    )).toMatchObject({
      kind: "workItem",
      project: "One",
      workItemId: "42",
    });
  });

  it("rejects unrelated and malformed links", () => {
    expect(parseAdoWorkReferenceUrl("https://example.com/One/_workitems/edit/42")).toBeNull();
    expect(parseAdoWorkReferenceUrl("http://msazure.visualstudio.com/One/_workitems/edit/42")).toBeNull();
    expect(parseAdoWorkReferenceUrl("https://msazure.visualstudio.com/One/_workitems/edit/not-a-number")).toBeNull();
  });
});

describe("matchesAdoProvider", () => {
  it("matches configured organization and project case-insensitively", () => {
    const reference = parseAdoWorkReferenceUrl(
      "https://dev.azure.com/MSAZURE/one/_workitems/edit/42",
    );
    expect(reference).not.toBeNull();
    expect(matchesAdoProvider(reference!, { org: "msazure", project: "One" })).toBe(true);
  });
});
