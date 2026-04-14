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
  const heading = (
    <>
      <h2 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">
        {title}
      </h2>
      {description && (
        <p className="text-xs text-text-muted mt-0.5">{description}</p>
      )}
    </>
  );

  return (
    <section>
      {action ? (
        <div className="flex items-center justify-between mb-3">
          <div>{heading}</div>
          {action}
        </div>
      ) : (
        <div className="mb-3">{heading}</div>
      )}
      {children}
    </section>
  );
}
