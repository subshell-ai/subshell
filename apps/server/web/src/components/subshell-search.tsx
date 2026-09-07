import { Input } from "@/components/ui/input";

/**
 * Search box filtering subshell cards by name, working directory, or harness.
 */
export function SubshellSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Search by name, path, or harness…"
      className="max-w-sm"
      aria-label="Search subshells"
    />
  );
}
