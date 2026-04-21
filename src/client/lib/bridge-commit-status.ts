import type { BridgeCommitComparison, BridgeCommitMetadata } from "../api";

export type BridgeStatusTone = "success" | "warning" | "error" | "info" | "neutral";
export type BridgeComparisonKind = "same" | "ahead" | "behind" | "diverged" | "unavailable" | "unknown";

export interface BridgeStatusDescriptor {
  label: string;
  detail: string;
  tone: BridgeStatusTone;
}

function formatCommitCount(count: number): string {
  return `${count} commit${count === 1 ? "" : "s"}`;
}

export function getBridgeComparisonKind(comparison: BridgeCommitComparison | null | undefined): BridgeComparisonKind {
  if (!comparison) return "unknown";
  if (comparison.status !== "ok") return "unavailable";
  if (comparison.ahead === 0 && comparison.behind === 0) return "same";
  if (comparison.ahead > 0 && comparison.behind === 0) return "ahead";
  if (comparison.ahead === 0 && comparison.behind > 0) return "behind";
  return "diverged";
}

export function describeLocalVsRemote(
  comparison: BridgeCommitComparison | null | undefined,
  loading: boolean,
): BridgeStatusDescriptor {
  if (loading && !comparison) {
    return {
      label: "Checking…",
      detail: "Refreshing tracked upstream commit metadata.",
      tone: "neutral",
    };
  }

  const kind = getBridgeComparisonKind(comparison);
  if (kind === "unavailable") {
    const error = comparison && comparison.status !== "ok"
      ? comparison.error
      : "Commit comparison is unavailable.";
    return {
      label: "Unavailable",
      detail: error,
      tone: "error",
    };
  }
  if (kind === "unknown") {
    return {
      label: "Unavailable",
      detail: "Commit comparison is unavailable.",
      tone: "neutral",
    };
  }
  if (!comparison || comparison.status !== "ok") {
    return {
      label: "Unavailable",
      detail: "Commit comparison is unavailable.",
      tone: "neutral",
    };
  }

  switch (kind) {
    case "same":
      return {
        label: "Up to date",
        detail: "Local HEAD matches the tracked upstream commit.",
        tone: "success",
      };
    case "ahead":
      return {
        label: `Ahead by ${comparison.ahead}`,
        detail: `Local HEAD has ${formatCommitCount(comparison.ahead)} that are not on the tracked upstream branch.`,
        tone: "info",
      };
    case "behind":
      return {
        label: `Behind by ${comparison.behind}`,
        detail: `Tracked upstream has ${formatCommitCount(comparison.behind)} that are not in local HEAD.`,
        tone: "warning",
      };
    case "diverged":
      return {
        label: "Diverged",
        detail: `Local HEAD is ${formatCommitCount(comparison.ahead)} ahead and ${formatCommitCount(comparison.behind)} behind upstream.`,
        tone: "warning",
      };
    default:
      return {
        label: "Unavailable",
        detail: "Commit comparison is unavailable.",
        tone: "neutral",
      };
  }
}

export function describeRunningVsLocal(
  comparison: BridgeCommitComparison | null | undefined,
  loading: boolean,
): BridgeStatusDescriptor {
  if (loading && !comparison) {
    return {
      label: "Checking…",
      detail: "Refreshing the running bridge commit metadata.",
      tone: "neutral",
    };
  }

  const kind = getBridgeComparisonKind(comparison);
  if (kind === "unavailable") {
    const error = comparison && comparison.status !== "ok"
      ? comparison.error
      : "Commit comparison is unavailable.";
    return {
      label: "Unavailable",
      detail: error,
      tone: "error",
    };
  }
  if (kind === "unknown") {
    return {
      label: "Unavailable",
      detail: "Commit comparison is unavailable.",
      tone: "neutral",
    };
  }
  if (!comparison || comparison.status !== "ok") {
    return {
      label: "Unavailable",
      detail: "Commit comparison is unavailable.",
      tone: "neutral",
    };
  }

  switch (kind) {
    case "same":
      return {
        label: "Matches local",
        detail: "The running bridge is serving the current local HEAD commit.",
        tone: "success",
      };
    case "ahead":
      return {
        label: "Local is older",
        detail: `The running bridge is ${formatCommitCount(comparison.ahead)} ahead of local HEAD.`,
        tone: "warning",
      };
    case "behind":
      return {
        label: "Restart needed",
        detail: `The running bridge is ${formatCommitCount(comparison.behind)} behind local HEAD.`,
        tone: "warning",
      };
    case "diverged":
      return {
        label: "Mismatch",
        detail: `The running bridge and local HEAD diverged (${formatCommitCount(comparison.ahead)} ahead, ${formatCommitCount(comparison.behind)} behind).`,
        tone: "warning",
      };
    default:
      return {
        label: "Unavailable",
        detail: "Commit comparison is unavailable.",
        tone: "neutral",
      };
  }
}

export function describeBridgeOverview(
  metadata: BridgeCommitMetadata | null | undefined,
  loading: boolean,
): BridgeStatusDescriptor {
  if (loading && !metadata) {
    return {
      label: "Checking…",
      detail: "Refreshing local, remote, and running bridge commits.",
      tone: "neutral",
    };
  }
  if (!metadata) {
    return {
      label: "Unavailable",
      detail: "Bridge commit metadata is unavailable.",
      tone: "neutral",
    };
  }

  const localKind = getBridgeComparisonKind(metadata.comparisons.localVsRemote);
  const runningKind = getBridgeComparisonKind(metadata.comparisons.runningVsLocal);
  if (localKind === "unavailable" || localKind === "unknown" || runningKind === "unavailable" || runningKind === "unknown") {
    return {
      label: "Partial status",
      detail: "Some commit comparisons are unavailable.",
      tone: "warning",
    };
  }
  if (localKind === "behind" || localKind === "diverged" || runningKind !== "same") {
    return {
      label: "Attention needed",
      detail: "Local HEAD is not fully aligned with upstream or the running bridge.",
      tone: "warning",
    };
  }
  if (localKind === "ahead") {
    return {
      label: "Local ahead",
      detail: "Local HEAD includes commits that have not reached upstream yet.",
      tone: "info",
    };
  }
  return {
    label: "All aligned",
    detail: "Local, upstream, and running bridge commits all match.",
    tone: "success",
  };
}
