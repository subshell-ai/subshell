import { cn, Input } from "@internal/node-admin";

/**
 * Search box filtering subshell cards by name, working directory, or harness.
 * `max-w-sm` suits the dialog that also uses it; the home page passes
 * `className` to stretch it across the full toolbar row so the row under it
 * (machine filter + view toggle) can align to the same edges.
 */
export function SubshellSearch({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Search by name, path, or harness…"
      className={cn("max-w-sm", className)}
      aria-label="Search subshells"
    />
  );
}
