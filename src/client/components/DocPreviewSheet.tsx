import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, BookOpen, ExternalLink, X } from "lucide-react";
import { Button, IconButton, Notice } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import DocsMarkdown from "./docs/DocsMarkdown";
import { buildTreeIndex, docsRoute, extractHeadings, stripLeadingTitle } from "./docs/docs-model";
import { isNotFoundError, useDocPageQuery, useDocsTreeQuery } from "./docs/docs-queries";
import { LoadingSkeletonRegion, SkeletonText } from "./shared/Skeleton";
import { useModalDialog } from "./shared/useModalDialog";

interface DocPreviewSheetProps {
  docPath: string;
  onClose: () => void;
  onOpenFull?: (path: string, hash: string) => void;
}

export default function DocPreviewSheet({ docPath, onClose, onOpenFull }: DocPreviewSheetProps) {
  const navigate = useNavigate();
  const [trail, setTrail] = useState<string[]>([docPath]);
  const address = trail.at(-1) ?? docPath;
  const separator = address.indexOf("#");
  const path = separator < 0 ? address : address.slice(0, separator);
  const hash = separator < 0 ? "" : address.slice(separator);
  const pageQuery = useDocPageQuery(path);
  const treeQuery = useDocsTreeQuery();
  const index = useMemo(() => buildTreeIndex(treeQuery.data?.tree ?? []), [treeQuery.data]);
  const doc = pageQuery.data;
  const body = useMemo(() => stripLeadingTitle(doc?.body ?? ""), [doc?.body]);
  const headings = useMemo(() => extractHeadings(body), [body]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { titleId, dialogProps } = useModalDialog({ onDismiss: onClose });

  useEffect(() => setTrail([docPath]), [docPath]);

  const scrollToHeading = (id: string) => {
    const container = scrollRef.current;
    const heading = Array.from(container?.querySelectorAll<HTMLElement>("[data-docs-heading]") ?? [])
      .find((element) => element.id === id);
    if (!container || !heading) return;
    container.scrollTo({ top: heading.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 16 });
  };

  useEffect(() => {
    if (!doc || !scrollRef.current) return;
    scrollRef.current.scrollTop = 0;
    if (!hash) return;
    let id = hash.slice(1);
    try { id = decodeURIComponent(id); } catch { /* Keep the literal fragment. */ }
    scrollToHeading(id);
  }, [doc, hash]);

  const openFull = () => {
    if (onOpenFull) onOpenFull(doc?.path ?? path, hash);
    else {
      onClose();
      navigate(docsRoute(doc?.path ?? path, hash));
    }
  };

  return (
    <div
      className={cx(DS.surface.scrim, "items-end p-0 md:items-center md:p-4")}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        {...dialogProps}
        className={cx(DS.surface.dialog, "relative flex max-h-[90dvh] w-full flex-col rounded-t-2xl md:max-w-3xl md:rounded-xl")}
        data-doc-preview={path}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          {trail.length > 1 && <IconButton label="Previous preview" size="md" onClick={() => setTrail((current) => current.slice(0, -1))}><ArrowLeft size={16} /></IconButton>}
          <h2 id={titleId} className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-text-primary">
            <BookOpen size={16} className="shrink-0 text-text-secondary" />
            <span className="truncate">{doc?.title ?? path}</span>
          </h2>
          <Button variant="ghost" onClick={openFull} icon={<ExternalLink size={14} />}>Open full</Button>
          <IconButton label="Close doc preview" size="md" onClick={onClose}><X size={16} /></IconButton>
        </header>
        <div className="shrink-0 border-b border-border-subtle px-5 py-2 text-xs text-text-secondary">
          <span className="font-mono break-all">{doc?.path ?? path}</span>
        </div>
        <div ref={scrollRef} className="docs-ui min-h-0 overflow-y-auto overscroll-contain px-5 py-5 md:px-8" style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}>
          {pageQuery.isPending && <LoadingSkeletonRegion isLoading label="Loading document preview"><SkeletonText lines={6} widths="paragraph" /></LoadingSkeletonRegion>}
          {pageQuery.isError && (
            <Notice tone="danger" title={isNotFoundError(pageQuery.error) ? "Page not found" : "Could not load this doc"}>
              <p>{pageQuery.error instanceof Error ? pageQuery.error.message : "The document request failed."}</p>
              {!isNotFoundError(pageQuery.error) && <Button variant="ghost" onClick={() => void pageQuery.refetch()}>Retry</Button>}
            </Notice>
          )}
          {doc && !pageQuery.isError && (
            <DocsMarkdown
              markdown={body}
              headings={headings}
              currentPath={doc.isFolderIndex && doc.path === "index" ? "" : doc.path}
              currentIsDirectory={doc.isFolderIndex}
              index={index}
              onAnchorSelect={scrollToHeading}
              onDocSelect={(nextPath, nextHash) => setTrail((current) => [...current, nextPath + nextHash])}
            />
          )}
        </div>
      </section>
    </div>
  );
}
