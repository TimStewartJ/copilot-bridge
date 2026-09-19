import { createContext, useContext, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, PanelLeftOpen } from "lucide-react";
import { docsRoute, type DocsCrumb, type DocsTarget, type DocsTreeIndex } from "./docs-model";
import { DocsIconButton } from "./docs-ui";

/** Shell state the individual Docs screens need: layout mode, navigation and shared actions. */
export interface DocsShell {
  isMobile: boolean;
  index: DocsTreeIndex;
  sidebarCollapsed: boolean;
  expandSidebar: () => void;
  goTo: (target: DocsTarget | string, options?: { replace?: boolean; edit?: boolean; hash?: string }) => void;
  goHome: () => void;
  /** Opens the "new page" dialog, optionally preselecting a folder and the page's address. */
  openNewPage: (folder?: string, slug?: string) => void;
  openNewEntry: (collectionPath: string) => void;
  /** Puts a query into the docs search and brings the search UI into view. */
  searchFor: (query: string) => void;
  focusSearch: () => void;
  wide: boolean;
  setWide: (wide: boolean) => void;
}

const DocsShellContext = createContext<DocsShell | null>(null);

export const DocsShellProvider = DocsShellContext.Provider;

export function useDocsShell(): DocsShell {
  const shell = useContext(DocsShellContext);
  if (!shell) throw new Error("useDocsShell must be used inside the Docs view");
  return shell;
}

export interface DocsTopBarProps {
  crumbs: DocsCrumb[];
  /** Shown on phones, where the breadcrumb trail does not fit. */
  title: string;
  actions?: ReactNode;
  /** Replaces the mobile back button, e.g. while editing. */
  mobileLeading?: ReactNode;
}

/** The single bar at the top of every Docs screen: where you are, and what you can do here. */
export function DocsTopBar({ crumbs, title, actions, mobileLeading }: DocsTopBarProps) {
  const { isMobile, sidebarCollapsed, expandSidebar, goHome } = useDocsShell();

  if (isMobile) {
    return (
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-bg-secondary pl-1.5 pr-2">
        {mobileLeading ?? <DocsIconButton icon={ChevronLeft} label="Back to Docs" size={20} onClick={goHome} className="h-10 w-10" />}
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text-primary">{title}</h1>
        {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
      </header>
    );
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-bg-primary px-4">
      {sidebarCollapsed && (
        <DocsIconButton icon={PanelLeftOpen} label="Show sidebar" onClick={expandSidebar} className="-ml-1.5" />
      )}
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1 text-[13px] text-text-muted">
          <li className="shrink-0">
            <Link to="/docs" className="rounded px-1.5 py-1 transition-colors hover:bg-bg-hover hover:text-text-primary">
              Docs
            </Link>
          </li>
          {crumbs.map((crumb, position) => (
            <li key={`${position}:${crumb.label}`} className="flex min-w-0 items-center gap-1">
              <ChevronRight size={13} className="shrink-0 text-text-faint" aria-hidden="true" />
              {crumb.target ? (
                <Link
                  to={docsRoute(crumb.target)}
                  className="max-w-[11rem] truncate rounded px-1.5 py-1 transition-colors hover:bg-bg-hover hover:text-text-primary"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span aria-current="page" className="truncate px-1.5 py-1 font-medium text-text-primary">
                  {crumb.label}
                </span>
              )}
            </li>
          ))}
        </ol>
      </nav>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </header>
  );
}
