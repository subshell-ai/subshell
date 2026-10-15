import { Input } from "@internal/node-admin";
import { useState } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import { sshPresetNameProblem } from "@/lib/ssh-input-validation";

export function SshPresetNameField({
  id,
  label,
  value,
  onChange,
  disabled,
  serverError,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  serverError?: string;
}) {
  const [touched, setTouched] = useState(false);
  const [focused, setFocused] = useState(false);
  const error = !focused ? serverError || (touched ? sshPresetNameProblem(value) : null) : null;
  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value}
        maxLength={120}
        disabled={disabled}
        required
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setTouched(true);
          setFocused(false);
        }}
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="text-destructive text-detail">
          {error}
        </p>
      )}
    </Field>
  );
}
