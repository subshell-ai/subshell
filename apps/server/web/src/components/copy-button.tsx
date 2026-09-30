import { Button } from "@internal/node-admin";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * A lone copy ICON button that ticks to a green check for 1.5 s and back. This
 * is the confirmation for every copy that is a control in its own right (a
 * prompt row, a stack row, a row inside a disclosure or a stack's members):
 * the icon flipping IS the answer, so a copy is never silent. The command-row
 * variant with its monospace value lives in `copy-command-row.tsx`.
 *
 * `label` names what is copied (the accessible name: "Copy prompt", then
 * "prompt copied" while the check is up), because an icon carries no text.
 * A blocked clipboard (a plain-http LAN, where `navigator.clipboard` is absent)
 * throws and the button stays quiet rather than faking a copy.
 */
export function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  /** What the button copies, e.g. "prompt", "stack", the member's description. */
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  // One live timer: a second press must not leave the first reset standing to
  // clear a check a later press raised (and the timer must not outlive the row).
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={className}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      onClick={(e) => {
        // The button sits inside clickable rows (the expander); a copy press is
        // not also a request to expand the thing around it.
        e.stopPropagation();
        void copy();
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}
