import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
 *
 * The glyphs carry an explicit size: an unsized lucide icon renders 24px,
 * which read as far too big in an `icon-sm` button (operator report
 * 2026-09-25, on the auth dialog's URI list — true of every list this
 * primitive serves, so it is fixed here rather than per call site).
 */
export function CopyableValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(): Promise<void> {
    try {
      clearTimeout(timer.current);
      setCopied(false);
      setFailed(false);
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          copyWithSelection(value);
        }
      } else {
        // HTTP LAN pages have no Clipboard API. Keep the fallback in the
        // click gesture so browsers can authorize the legacy copy command.
        copyWithSelection(value);
      }
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setFailed(true);
    }
  }

  return (
    <span className="flex items-start gap-1">
      <span className="min-w-0 break-all">{value}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        // 28px is a BUTTON-sized target; in a dense fact list the box read
        // bigger than the value it copies (operator, 2026-09-25). The svg
        // must be sized THROUGH the same `[&_svg]` variant the button ships
        // (`[&_svg]:size-4`): a plain utility on the glyph loses to that
        // descendant selector, which is why the first shrink attempt still
        // measured 16px. Same modifier shape, so `cn` replaces it.
        className="h-5 w-5 [&_svg]:size-3"
        aria-label={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
        onClick={() => void copy()}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
      {failed && <span role="alert">Could not copy. Select the value and copy it manually.</span>}
    </span>
  );
}

/** Legacy clipboard path for browsers on HTTP; restore focus and selection. */
function copyWithSelection(value: string): void {
  const focused = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i)) : [];
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  try {
    input.focus({ preventScroll: true });
    input.select();
    if (!document.execCommand("copy")) throw new Error("Clipboard copy refused");
  } finally {
    input.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    selection?.removeAllRanges();
    for (const range of ranges) selection?.addRange(range);
  }
}
