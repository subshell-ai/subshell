import { cn, Input } from "@internal/node-admin";
import { useState } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import { RequiredMark } from "@/components/ui/required-mark";
import { REQUIREMENT_CAPTION_CLASS } from "@/lib/requirement-tone";
import { SSH_PRESET_NAME_MAX, sshPresetNameProblem } from "@/lib/ssh-input-validation";

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
  // Gold means "nothing typed yet" (ruling 2026-09-30): a caret-leave on an
  // empty field is a requirement gap, not a refused value. A refused value or
  // the server's refusal of the submit stays red.
  const clientProblem = !focused && touched ? sshPresetNameProblem(value) : null;
  const gap = clientProblem !== null && !value.trim();
  const error = serverError || clientProblem;
  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor={id}>
        {label}
        <RequiredMark />
      </FieldLabel>
      <Input
        id={id}
        value={value}
        maxLength={SSH_PRESET_NAME_MAX}
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
        <p
          id={`${id}-error`}
          role="alert"
          className={cn(gap ? REQUIREMENT_CAPTION_CLASS : "text-destructive text-detail")}
        >
          {error}
        </p>
      )}
    </Field>
  );
}
