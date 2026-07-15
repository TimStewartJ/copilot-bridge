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
                      ? "bg-accent-surface text-accent shadow-sm ring-1 ring-accent-border"
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
          <p className="px-2 pb-2 text-xs font-semibold tracking-wide text-text-secondary">
            Categories
          </p>
          <div className="space-y-1">
            {categories.map((category) => {
              const isActive = category.id === activeCategory;

              return (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => onSelectCategory(category.id)}
                  aria-pressed={isActive}
                  className={classes(
                    "flex w-full items-center rounded-lg px-3 py-2.5 text-left transition-colors",
                    isActive
                      ? "bg-accent-surface text-accent ring-1 ring-accent-border"
                      : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
                  )}
                >
                  <span className="min-w-0 text-sm font-medium">{category.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </nav>
    </div>
  );
}
