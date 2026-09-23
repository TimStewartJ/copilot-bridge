import { Fragment } from "react";
import { normalizeCategory, SETTINGS_CATEGORIES, type CategoryId, type CategoryMeta } from "./settings-layout";
import { DS, cx } from "../../design/tokens";
import { Select } from "../../design/primitives";

export interface SettingsCategoryNavProps {
  activeCategory: CategoryId;
  onSelectCategory: (category: CategoryId) => void;
  categories?: readonly CategoryMeta[];
  ariaLabel?: string;
  className?: string;
  desktopStickyTopClassName?: string;
}

export function SettingsCategoryNav({
  activeCategory,
  onSelectCategory,
  categories = SETTINGS_CATEGORIES,
  ariaLabel = "Settings categories",
  className,
  desktopStickyTopClassName = "@[44rem]/settings-layout:top-6",
}: SettingsCategoryNavProps) {
  return (
    <div className={cx("min-w-0", className)}>
      <nav aria-label={ariaLabel} className="@[44rem]/settings-layout:hidden">
        <Select
          aria-label="Settings category"
          value={activeCategory}
          onChange={(event) => onSelectCategory(normalizeCategory(event.target.value))}
        >
          {categories.map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}
        </Select>
      </nav>

      <nav aria-label={ariaLabel} className={cx("hidden @[44rem]/settings-layout:block @[44rem]/settings-layout:sticky", desktopStickyTopClassName)}>
        <div className="space-y-0.5">
          {categories.map((category, index) => {
            const active = category.id === activeCategory;
            const startsGroup = index > 0 && categories[index - 1]?.group !== category.group;
            return (
              <Fragment key={category.id}>
                {startsGroup && <div role="separator" className={DS.menu.divider} />}
                <button
                  type="button"
                  onClick={() => onSelectCategory(category.id)}
                  aria-pressed={active}
                  aria-current={active ? "page" : undefined}
                  className={cx(DS.menu.item, active && DS.menu.selected)}
                >
                  {category.label}
                </button>
              </Fragment>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
