import { Button } from "@internal/node-admin";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

/**
 * A monospace value with a copy affordance — the shared row for any block
 * instructing the operator to run or paste something (harness install, MCP
 * registration, a node's setup key). The 1.5 s reset and the blocked-clipboard
 * fallback live here, once.
 *
 * The button is the copy ICON, never the word "Copy" (Patterns,
 * `docs/design-system.md`). Five surfaces had drawn five affordances for one act — a
 * bordered "Copy" here, "Copied" in the API-key dialog, a bare icon in a preset row —
 * and the word repeated the thing the monospace value beside it already said.
 *
 * `label` names WHAT the button copies, and with the word gone it is the ONLY thing
 * that does: a screen can hold two of these rows for one task — the Add-node dialog's
 * desktop path shows an address and a key — and their buttons are now identical
 * pixels. So it is required by convention wherever more than one row appears, and it
 * sets the accessible name (`Copy server address`, then `server address copied` while
 * the check is up). It stays OPTIONAL because every other caller is a lone command on
 * its own screen, where it keeps the two names it has always had.
 *
 * `disabled` keeps the value visible but refuses the copy. The Add-node dialog's
 * one-liner uses it before the key exists: the command shape is the instruction and
 * belongs on screen from the start, but copying a command whose token slot is a
 * placeholder would run it as-is on a stranger's machine.
 */
export function CopyCommandRow({ text, label, disabled }: { text: string; label?: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (non-secure context); the text stays visible.
    }
  }

  // An icon has no text to be named by, so `aria-label` is the whole name. Where no
  // `label` was passed these are the two words the button used to RENDER, kept verbatim
  // so no test, no screen reader and no muscle memory finds a renamed control.
  const name = copied
    ? label === undefined
      ? "Copied"
      : `${label} copied`
    : label === undefined
      ? "Copy"
      : `Copy ${label}`;

  return (
    <div className="flex items-center gap-2 rounded-md bg-muted p-2">
      <code className="min-w-0 flex-1 break-all font-mono text-detail">{text}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={name}
        disabled={disabled}
        onClick={() => void copy()}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}
