import { cloneElement, useId, type ComponentProps, type ReactElement } from "react";
import { DS } from "../../design/tokens";

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | null;
  children: ReactElement<ComponentProps<"input"> | ComponentProps<"select"> | ComponentProps<"textarea">>;
}) {
  const generatedId = useId();
  const id = children.props.id ?? generatedId;
  const errorId = `${id}-error`;
  return (
    <div>
      <label htmlFor={id} className={`mb-1.5 block ${DS.field.label}`}>
        {label}
      </label>
      {cloneElement(children, {
        id,
        "aria-invalid": error ? true : children.props["aria-invalid"],
        "aria-describedby": [children.props["aria-describedby"], error ? errorId : undefined].filter(Boolean).join(" ") || undefined,
      })}
      {error && <p id={errorId} role="alert" className="mt-1 text-xs text-error">{error}</p>}
    </div>
  );
}
