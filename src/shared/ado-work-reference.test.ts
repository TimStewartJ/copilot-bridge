import { describe, expect, it } from "vitest";
import { buildAdoPullRequestUrl, matchesAdoOrganization, parseAdoWorkReferenceUrl } from "./ado-work-reference.js";

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

describe("matchesAdoOrganization", () => {
  it("matches the configured organization case-insensitively", () => {
    const reference = parseAdoWorkReferenceUrl(
      "https://dev.azure.com/EXAMPLEORG/one/_workitems/edit/42",
    );
    expect(reference).not.toBeNull();
    expect(matchesAdoOrganization(reference!, { org: "exampleorg" })).toBe(true);
  });

  it("accepts links from other projects in the organization but not other organizations", () => {
    const otherProject = parseAdoWorkReferenceUrl(
      "https://dev.azure.com/exampleorg/exampleproject/_git/sample-repo/pullrequest/10000005",
    );
    const otherOrganization = parseAdoWorkReferenceUrl(
      "https://other.visualstudio.com/One/_git/Repo/pullrequest/42",
    );
    expect(matchesAdoOrganization(otherProject!, { org: "exampleorg" })).toBe(true);
    expect(matchesAdoOrganization(otherOrganization!, { org: "exampleorg" })).toBe(false);
  });
});

describe("buildAdoPullRequestUrl", () => {
  it("builds a pull request web link with encoded project and repository names", () => {
    expect(buildAdoPullRequestUrl({
      org: "exampleorg",
      project: "exampleproject",
      repository: "sample-repo",
      prId: 10000005,
    })).toBe("https://exampleorg.visualstudio.com/exampleproject/_git/sample-repo/pullrequest/10000005");
    expect(buildAdoPullRequestUrl({
      org: "exampleorg",
      project: "Azure Stack",
      repository: "Repo Name",
      prId: 42,
    })).toBe("https://exampleorg.visualstudio.com/Azure%20Stack/_git/Repo%20Name/pullrequest/42");
  });
});
