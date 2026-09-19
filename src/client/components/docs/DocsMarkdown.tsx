import { memo, useMemo, type ComponentPropsWithoutRef, type MouseEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link2 } from "lucide-react";
import remarkWikilink from "../../lib/remark-wikilink";
import remarkLabelBreaks from "../../lib/remark-label-breaks";
import CodeBlock from "../CodeBlock";
import { useWikilinksQuery } from "./docs-queries";
import {
  canonicalDocPath,
  docsRoute,
  extractWikilinkTargets,
  isExternalHref,
  resolveRelativeDocPath,
  slugifyHeading,
  type DocHeading,
  type DocsTreeIndex,
} from "./docs-model";

export interface DocsMarkdownProps {
  markdown: string;
  /** Headings extracted from this exact markdown string; rendered headings take their ids from it. */
  headings: DocHeading[];
  /** Location the markdown belongs to, used to resolve relative links. Null disables that. */
  currentPath: string | null;
  currentIsDirectory: boolean;
  index: DocsTreeIndex;
  /** Called for in-page anchors: heading permalinks and `#fragment` links. */
  onAnchorSelect?: (id: string, source: "heading" | "link") => void;
}

interface MarkdownNode {
  position?: { start?: { line?: number } };
}

type HeadingProps = ComponentPropsWithoutRef<"h2"> & { node?: MarkdownNode };
type AnchorProps = ComponentPropsWithoutRef<"a"> & { node?: unknown };
type TableProps = ComponentPropsWithoutRef<"table"> & { node?: unknown };
type ImageProps = ComponentPropsWithoutRef<"img"> & { node?: unknown };

// No remark-breaks here on purpose: docs are hard-wrapped, so newlines inside a paragraph are
// spaces. remarkLabelBreaks restores line breaks for "**Label:** value" blocks only.
const REMARK_PLUGINS = [remarkGfm, remarkWikilink, remarkLabelBreaks];

function wikiUrlTransform(url: string): string {
  return url.startsWith("wiki:") ? url : defaultUrlTransform(url);
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (typeof node === "object" && "props" in node) {
    return nodeText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

function DocsMarkdown({ markdown, headings, currentPath, currentIsDirectory, index, onAnchorSelect }: DocsMarkdownProps) {
  const wikilinkTargets = useMemo(() => extractWikilinkTargets(markdown), [markdown]);
  const { data: resolvedLinks } = useWikilinksQuery(wikilinkTargets);

  const components = useMemo(() => {
    const idByLine = new Map(headings.map((heading) => [heading.line, heading.id]));

    const heading = (level: 1 | 2 | 3 | 4 | 5 | 6) => function DocsHeading({ node, children, ...props }: HeadingProps) {
      const Tag = `h${level}` as const;
      const line = node?.position?.start?.line;
      const id = (line ? idByLine.get(line) : undefined) ?? slugifyHeading(nodeText(children));
      return (
        <Tag {...props} id={id} data-docs-heading="">
          {children}
          {onAnchorSelect && (
            <a
              href={`#${id}`}
              className="docs-heading-anchor"
              aria-label={`Copy link to “${nodeText(children)}”`}
              onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                event.preventDefault();
                onAnchorSelect(id, "heading");
              }}
            >
              <Link2 size={15} aria-hidden="true" />
            </a>
          )}
        </Tag>
      );
    };

    const anchor = ({ href, children, node: _node, ...props }: AnchorProps) => {
      if (!href) return <a {...props}>{children}</a>;

      if (href.startsWith("wiki:")) {
        const target = href.slice("wiki:".length);
        const resolved = resolvedLinks?.[target];
        if (resolved) {
          return <Link {...props} to={docsRoute(resolved.path)} title={resolved.title}>{children}</Link>;
        }
        const missing = resolvedLinks !== undefined && target in resolvedLinks;
        return (
          <span className={missing ? "docs-broken-link" : undefined} title={missing ? `No page named “${target}”` : undefined}>
            {children}
          </span>
        );
      }

      if (isExternalHref(href)) {
        return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
      }

      if (href.startsWith("#")) {
        return (
          <a
            {...props}
            href={href}
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              if (!onAnchorSelect) return;
              event.preventDefault();
              let id = href.slice(1);
              try {
                id = decodeURIComponent(id);
              } catch {
                // Keep the literal fragment.
              }
              onAnchorSelect(id, "link");
            }}
          >
            {children}
          </a>
        );
      }

      if (currentPath === null) return <a {...props} href={href}>{children}</a>;

      const docsRelative = href.startsWith("/docs/") ? href.slice("/docs".length) : href;
      const resolved = resolveRelativeDocPath(currentPath, docsRelative, currentIsDirectory);
      const fragmentIndex = resolved.indexOf("#");
      const path = canonicalDocPath(fragmentIndex >= 0 ? resolved.slice(0, fragmentIndex) : resolved, index);
      const fragment = fragmentIndex >= 0 ? resolved.slice(fragmentIndex) : "";
      const folder = index.folders.get(path);
      const kind = folder?.isDb && !folder.hasIndex ? "collection" : "page";
      return <Link {...props} to={docsRoute({ path, kind }, fragment)}>{children}</Link>;
    };

    return {
      pre: CodeBlock,
      h1: heading(1),
      h2: heading(2),
      h3: heading(3),
      h4: heading(4),
      h5: heading(5),
      h6: heading(6),
      a: anchor,
      // Wide tables scroll inside their own frame instead of stretching the page.
      table: ({ node: _node, ...props }: TableProps) => (
        <div className="docs-table-scroll" tabIndex={0} role="region" aria-label="Table">
          <table {...props} />
        </div>
      ),
      img: ({ node: _node, alt, ...props }: ImageProps) => <img {...props} alt={alt ?? ""} loading="lazy" />,
    };
  }, [headings, resolvedLinks, currentPath, currentIsDirectory, index, onAnchorSelect]);

  return (
    <div className="docs-prose prose prose-invert max-w-none">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components} urlTransform={wikiUrlTransform}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

export default memo(DocsMarkdown);
