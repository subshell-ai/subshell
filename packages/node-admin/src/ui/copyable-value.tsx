import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "./button";

/**
 * A value with a copy affordance, for paths and command lines.
 *
 * The console offered Reveal buttons beside these; a served page cannot open
 * Finder, and the person most likely to want one of these strings is on a
 * headless box where the useful thing is the text itself. So: shown in full,
 * and one press to take it.
 *
 * Not {@link CopyCommandRow}, which is a full-width instruction block — this is an
 * inline value inside a list of facts. Both use the same affordance: the icon, and the
 * thing's name in `aria-label` (Patterns, `docs/design-system.md`).
 */
export function CopyableValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (a non-secure context); the text stays on screen.
    }
  }

  return (
    <span className="flex items-start gap-1">
      <span className="min-w-0 break-all">{value}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
        onClick={() => void copy()}
      >
        {copied ? <Check className="text-success" /> : <Copy />}
      </Button>
    </span>
  );
}
