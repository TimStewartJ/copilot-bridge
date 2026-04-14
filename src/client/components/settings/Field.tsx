export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-1">
        {label}
      </label>
      {children}
      {error && <p className="text-[10px] text-error mt-0.5">{error}</p>}
    </div>
  );
}
