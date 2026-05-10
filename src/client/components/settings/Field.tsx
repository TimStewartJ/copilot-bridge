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
      <label className="mb-1 block text-xs font-semibold tracking-wide text-text-secondary">
        {label}
      </label>
      {children}
      {error && <p className="text-[10px] text-error mt-0.5">{error}</p>}
    </div>
  );
}
