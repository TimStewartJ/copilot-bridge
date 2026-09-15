import { describe, expect, it } from "vitest";
import { buildAdoPullRequestUrl, matchesAdoOrganization, parseAdoWorkReferenceUrl } from "./ado-work-reference.js";

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

describe("matchesAdoOrganization", () => {
  it("matches the configured organization case-insensitively", () => {
    const reference = parseAdoWorkReferenceUrl(
      "https://dev.azure.com/MSAZURE/one/_workitems/edit/42",
    );
    expect(reference).not.toBeNull();
    expect(matchesAdoOrganization(reference!, { org: "msazure" })).toBe(true);
  });

  it("accepts links from other projects in the organization but not other organizations", () => {
    const otherProject = parseAdoWorkReferenceUrl(
      "https://dev.azure.com/msazure/msk8s/_git/SFFLinux-OS-Composition/pullrequest/17135261",
    );
    const otherOrganization = parseAdoWorkReferenceUrl(
      "https://other.visualstudio.com/One/_git/Repo/pullrequest/42",
    );
    expect(matchesAdoOrganization(otherProject!, { org: "msazure" })).toBe(true);
    expect(matchesAdoOrganization(otherOrganization!, { org: "msazure" })).toBe(false);
  });
});

describe("buildAdoPullRequestUrl", () => {
  it("builds a pull request web link with encoded project and repository names", () => {
    expect(buildAdoPullRequestUrl({
      org: "msazure",
      project: "msk8s",
      repository: "SFFLinux-OS-Composition",
      prId: 17135261,
    })).toBe("https://msazure.visualstudio.com/msk8s/_git/SFFLinux-OS-Composition/pullrequest/17135261");
    expect(buildAdoPullRequestUrl({
      org: "msazure",
      project: "Azure Stack",
      repository: "Repo Name",
      prId: 42,
    })).toBe("https://msazure.visualstudio.com/Azure%20Stack/_git/Repo%20Name/pullrequest/42");
  });
});
