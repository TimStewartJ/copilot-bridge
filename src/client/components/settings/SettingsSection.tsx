import { Section } from "../../design/primitives";
import { DS, cx } from "../../design/tokens";

/**
 * One section of a settings category. The description is a single short line at most; longer
 * explanations belong behind a Details inside the section.
 */
export function SettingsSection({
  id,
  title,
  description,
  count,
  action,
  children,
}: {
  id?: string;
  title: string;
  description?: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Section id={id} label={title} count={count} action={action} level="page" className="min-w-0 scroll-mt-4">
      {description && <p className={cx(DS.field.help, "-mt-1 mb-3 max-w-[72ch]")}>{description}</p>}
      <div className="min-w-0">{children}</div>
    </Section>
  );
}
