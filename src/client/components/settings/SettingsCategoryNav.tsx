import { SETTINGS_CATEGORIES, type CategoryId, type CategoryMeta } from "./settings-layout";

export interface SettingsCategoryNavProps {
  activeCategory: CategoryId;
  onSelectCategory: (category: CategoryId) => void;
  categories?: readonly CategoryMeta[];
  ariaLabel?: string;
  className?: string;
  desktopStickyTopClassName?: string;
}

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function SettingsCategoryNav({
  activeCategory,
  onSelectCategory,
  categories = SETTINGS_CATEGORIES,
  ariaLabel = "Settings categories",
  className,
  desktopStickyTopClassName = "md:top-6",
}: SettingsCategoryNavProps) {
  return (
    <div className={className}>
      <nav aria-label={ariaLabel} className="md:hidden">
        <div className="-mx-1 overflow-x-auto pb-1">
          <div className="inline-flex min-w-full gap-1 rounded-xl border border-border bg-bg-elevated p-1">
            {categories.map((category) => {
              const isActive = category.id === activeCategory;

              return (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => onSelectCategory(category.id)}
                  aria-pressed={isActive}
                  className={classes(
                    "flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-accent text-white shadow-sm"
                      : "text-text-muted hover:bg-bg-hover hover:text-text-secondary",
                  )}
                >
                  {category.label}
                </button>
              );
            })}
          </div>
        </div>
      </nav>

      <nav aria-label={ariaLabel} className={classes("hidden md:block md:sticky", desktopStickyTopClassName)}>
        <div className="rounded-xl border border-border bg-bg-elevated p-2">
          <p className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Categories
          </p>
          <div className="space-y-1">
            {categories.map((category) => {
              const isActive = category.id === activeCategory;
              const sectionCount = category.sections.length;
              const sectionLabel = sectionCount === 1 ? "section" : "sections";

              return (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => onSelectCategory(category.id)}
                  aria-pressed={isActive}
                  className={classes(
                    "flex w-full items-center rounded-lg px-3 py-2.5 text-left transition-colors",
                    isActive
                      ? "bg-accent/10 text-accent"
                      : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{category.label}</span>
                    <span className={classes("block text-xs", isActive ? "text-accent/80" : "text-text-muted")}>
                      {sectionCount} {sectionLabel}
                    </span>
                  </span>

                </button>
              );
            })}
          </div>
        </div>
      </nav>
    </div>
  );
}
