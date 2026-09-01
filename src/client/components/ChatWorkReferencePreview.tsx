import { useEffect, useState } from "react";
import type { AdoWorkReference } from "../../shared/ado-work-reference";
import {
  fetchWorkReferencePreview,
  type EnrichedPR,
  type EnrichedWorkItem,
  type WorkReferencePreview,
} from "../api";
import { PullRequestPreviewCard, WorkItemPreviewCard } from "./WorkReferenceCards";

const previewRequests = new Map<string, Promise<WorkReferencePreview>>();
const MAX_PREVIEW_REQUESTS = 200;

function requestPreview(url: string): Promise<WorkReferencePreview> {
  const existing = previewRequests.get(url);
  if (existing) return existing;

  const request = fetchWorkReferencePreview(url);
  previewRequests.set(url, request);
  if (previewRequests.size > MAX_PREVIEW_REQUESTS) {
    const oldestUrl = previewRequests.keys().next().value;
    if (typeof oldestUrl === "string" && oldestUrl !== url) previewRequests.delete(oldestUrl);
  }
  void request.catch(() => {
    if (previewRequests.get(url) === request) previewRequests.delete(url);
  });
  return request;
}

function fallbackTitle(label: string, url: string): string | null {
  const trimmed = label.trim();
  return trimmed && trimmed !== url ? trimmed : null;
}

function fallbackWorkItem(
  reference: Extract<AdoWorkReference, { kind: "workItem" }>,
  url: string,
  label: string,
): EnrichedWorkItem {
  return {
    id: reference.workItemId,
    provider: "ado",
    title: fallbackTitle(label, url),
    state: null,
    type: null,
    assignedTo: null,
    areaPath: null,
    url,
  };
}

function fallbackPullRequest(
  reference: Extract<AdoWorkReference, { kind: "pullRequest" }>,
  url: string,
  label: string,
): EnrichedPR {
  return {
    repoId: reference.repoId,
    repoName: reference.repoName,
    prId: reference.prId,
    provider: "ado",
    title: fallbackTitle(label, url),
    status: null,
    createdBy: null,
    reviewerCount: 0,
    url,
  };
}

export default function ChatWorkReferencePreview({
  reference,
  url,
  label,
}: {
  reference: AdoWorkReference;
  url: string;
  label: string;
}) {
  const [loaded, setLoaded] = useState<{ url: string; preview: WorkReferencePreview } | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setFailedUrl(null);
    void requestPreview(url).then(
      (result) => {
        if (active) setLoaded({ url, preview: result });
      },
      () => {
        if (active) setFailedUrl(url);
      },
    );
    return () => {
      active = false;
    };
  }, [url]);

  const preview = loaded?.url === url ? loaded.preview : null;
  const failed = failedUrl === url;
  const state = preview ? "loaded" : failed ? "fallback" : "loading";
  const card = reference.kind === "workItem"
    ? (
        <WorkItemPreviewCard
          item={preview?.kind === "workItem"
            ? preview.workItem
            : fallbackWorkItem(reference, url, label)}
        />
      )
    : (
        <PullRequestPreviewCard
          pullRequest={preview?.kind === "pullRequest"
            ? preview.pullRequest
            : fallbackPullRequest(reference, url, label)}
        />
      );
  return (
    <div
      className="not-prose my-2 max-w-xl"
      aria-busy={state === "loading" || undefined}
      data-work-reference-preview={state}
      title={failed ? "Rich preview unavailable. Open the Azure DevOps link for details." : undefined}
    >
      {card}
    </div>
  );
}
