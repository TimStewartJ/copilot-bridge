import { Section } from "../../design/primitives";
import { DS, cx } from "../../design/tokens";

export function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Section label={title} action={action} level="page" className="min-w-0">
      {description && <p className={cx(DS.text.prose, "mb-4 max-w-[72ch]")}>{description}</p>}
      <div className="min-w-0">{children}</div>
    </Section>
  );
}
