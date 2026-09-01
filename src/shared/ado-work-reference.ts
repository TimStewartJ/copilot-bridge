export interface AdoWorkItemReference {
  kind: "workItem";
  org: string;
  project: string;
  workItemId: string;
}

export interface AdoPullRequestReference {
  kind: "pullRequest";
  org: string;
  project: string;
  repoId: string;
  repoName: string;
  prId: number;
}

export type AdoWorkReference = AdoWorkItemReference | AdoPullRequestReference;

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseAdoLocation(url: URL): {
  org: string;
  project: string;
  routeSegments: string[];
} | null {
  const decodedSegments: string[] = [];
  for (const segment of url.pathname.split("/").filter(Boolean)) {
    const decoded = decodePathSegment(segment);
    if (decoded === null) return null;
    decodedSegments.push(decoded);
  }

  let org: string;
  let routeSegments: string[];
  const hostname = url.hostname.toLowerCase();
  if (hostname === "dev.azure.com") {
    const [pathOrg, ...remaining] = decodedSegments;
    if (!pathOrg) return null;
    org = pathOrg;
    routeSegments = remaining;
  } else if (hostname.endsWith(".visualstudio.com")) {
    org = url.hostname.slice(0, -".visualstudio.com".length);
    if (!org || org.includes(".")) return null;
    routeSegments = decodedSegments;
  } else {
    return null;
  }

  if (routeSegments[0]?.toLowerCase() === "defaultcollection") {
    routeSegments = routeSegments.slice(1);
  }

  const markerIndex = routeSegments.findIndex((segment) => {
    const normalized = segment.toLowerCase();
    return normalized === "_workitems" || normalized === "_git";
  });
  if (markerIndex < 1) return null;

  const project = routeSegments[markerIndex - 1];
  if (!project) return null;
  return {
    org,
    project,
    routeSegments: routeSegments.slice(markerIndex),
  };
}

export function parseAdoWorkReferenceUrl(value: string): AdoWorkReference | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;

  const location = parseAdoLocation(url);
  if (!location) return null;
  const [route, ...details] = location.routeSegments;

  if (route.toLowerCase() === "_workitems" && details[0]?.toLowerCase() === "edit") {
    const workItemId = details[1];
    if (parsePositiveInteger(workItemId) === null) return null;
    return {
      kind: "workItem",
      org: location.org,
      project: location.project,
      workItemId,
    };
  }

  if (route.toLowerCase() === "_git" && details[1]?.toLowerCase() === "pullrequest") {
    const repoName = details[0];
    const prId = parsePositiveInteger(details[2]);
    if (!repoName || prId === null) return null;
    return {
      kind: "pullRequest",
      org: location.org,
      project: location.project,
      repoId: repoName,
      repoName,
      prId,
    };
  }

  return null;
}

export function matchesAdoProvider(
  reference: Pick<AdoWorkReference, "org" | "project">,
  provider: { org: string; project: string },
): boolean {
  return reference.org.trim().toLowerCase() === provider.org.trim().toLowerCase()
    && reference.project.trim().toLowerCase() === provider.project.trim().toLowerCase();
}
