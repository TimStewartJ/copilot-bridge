// Home and Helm are one page: Helm's brief beside the Helm conversation. Wide screens show both;
// narrower ones switch between them, and the address says which is showing (Home is the brief,
// /helm the conversation) so links, the back button and the hands-free dock keep working.
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { SegmentedControl } from "../design/primitives";
import { cx, DS } from "../design/tokens";
import { useMediaQuery } from "../useIsMobile";

export const HELM_PAGE_WIDE_QUERY = "(min-width: 1280px)";

export type HelmPagePane = "brief" | "talk";

export default function HelmPage({ pane, brief, talk }: {
  pane: HelmPagePane;
  brief: (layout: "full" | "column") => ReactNode;
  talk: ReactNode;
}) {
  const wide = useMediaQuery(HELM_PAGE_WIDE_QUERY);
  const navigate = useNavigate();
  if (wide) {
    return <div className="flex min-h-0 flex-1">
      <section aria-label="Helm's brief" className="relative flex w-[30rem] shrink-0 flex-col border-r border-border 2xl:w-[34rem]">{brief("column")}</section>
      <section aria-label="Talk to Helm" className="flex min-w-0 flex-1 flex-col">{talk}</section>
    </div>;
  }
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className={cx(DS.surface.pane, "flex shrink-0 justify-center border-b border-border px-3 py-1.5")}>
      <SegmentedControl<HelmPagePane> ariaLabel="Brief or talk" size="sm" value={pane} fullWidth className="max-w-xs"
        options={[{ value: "brief", label: "Brief" }, { value: "talk", label: "Talk" }]}
        onChange={(next) => { if (next !== pane) navigate(next === "talk" ? "/helm" : "/dashboard/home", { replace: true }); }} />
    </div>
    {pane === "talk" ? talk : brief("full")}
  </div>;
}
