import { useId, type ReactNode } from "react";

/** A labelled form control with optional helper text and an error linked for screen readers. */
export function Field({
  id: fixedId,
  label,
  hint,
  error,
  required,
  children,
}: {
  /** Set when other code needs to focus this control, e.g. the first invalid field. */
  id?: string;
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean; required?: boolean }) => ReactNode;
}) {
  const autoId = useId();
  const id = fixedId ?? autoId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required && <span className="req" aria-hidden="true"> *</span>}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined, required })}
      {hint && (
        <p id={hintId} className="hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
