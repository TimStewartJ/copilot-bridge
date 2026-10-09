import { useMemo } from "react";
import { useWikilinksQuery } from "./docs/docs-queries";
import { BridgeReferenceCard, BridgeReferenceChip } from "./BridgeReference";
import { DS, cx } from "../design/tokens";

export default function ChatDocLink({ target, label, card = false }: {
  target: string;
  label?: string;
  card?: boolean;
}) {
  const targets = useMemo(() => [target], [target]);
  const query = useWikilinksQuery(targets);
  const resolved = query.data?.[target];
  const missing = query.data !== undefined && resolved === null;
  const failed = query.isError;

  if (!resolved) {
    const detail = missing ? `Page not found: ${target}` : failed ? `Could not resolve doc link: ${target}` : `Loading doc link: ${target}`;
    return (
      <span
        className={cx(DS.text.prose, (missing || failed) && "text-error")}
        title={detail}
        aria-label={detail}
        aria-busy={!missing && !failed || undefined}
        data-doc-link-state={missing ? "missing" : failed ? "error" : "loading"}
      >
        {label ?? target}
        {(missing || failed) && <span className="ml-1 text-xs">({missing ? "page not found" : "link unavailable"})</span>}
      </span>
    );
  }

  const Reference = card ? BridgeReferenceCard : BridgeReferenceChip;
  return <Reference target={{ kind: "doc", path: resolved.path }} label={label ?? resolved.title} />;
}
