import React from "react";
import {
  Bug,
  CheckSquare,
  BookOpen,
  Target,
  Trophy,
} from "lucide-react";

/** Icon + color for each ADO work item type */
export const WI_TYPE_ICONS: Record<string, { icon: React.ReactNode; color: string }> = {
  Bug: { icon: React.createElement(Bug, { size: 12, className: "text-error" }), color: "text-error" },
  Task: { icon: React.createElement(CheckSquare, { size: 12, className: "text-accent" }), color: "text-accent" },
  "User Story": { icon: React.createElement(BookOpen, { size: 12, className: "text-success" }), color: "text-success" },
  Feature: { icon: React.createElement(Target, { size: 12, className: "text-agent" }), color: "text-agent" },
  Epic: { icon: React.createElement(Trophy, { size: 12, className: "text-warning" }), color: "text-warning" },
};

/** CSS classes for work item state badges */
export const WI_STATE_STYLES: Record<string, string> = {
  New: "bg-text-muted/15 text-text-muted",
  Active: "bg-accent/15 text-accent",
  "In Progress": "bg-accent/15 text-accent",
  Resolved: "bg-success/15 text-success",
  Closed: "bg-text-faint/15 text-text-faint",
  Done: "bg-success/15 text-success",
};

/** CSS dot class + label for PR statuses */
export const PR_STATUS_STYLES: Record<string, { dot: string; label: string }> = {
  active: { dot: "bg-accent", label: "Active" },
  completed: { dot: "bg-success", label: "Completed" },
  abandoned: { dot: "bg-text-muted", label: "Abandoned" },
};

/** Map a work item state string to a Tailwind color class (for Dashboard cards) */
export function stateColor(state: string): string {
  const s = state.toLowerCase();
  if (s === "active" || s === "in progress" || s === "committed")
    return "bg-info/15 text-info";
  if (s === "new" || s === "to do" || s === "proposed")
    return "bg-text-muted/15 text-text-muted";
  if (s === "resolved" || s === "done" || s === "closed" || s === "completed")
    return "bg-success/15 text-success";
  if (s === "removed")
    return "bg-danger/15 text-danger";
  return "bg-text-muted/10 text-text-muted";
}
