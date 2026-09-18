import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * A monospace value with a copy affordance — the shared row for any block
 * instructing the operator to run or paste something (harness install, MCP
 * registration, a node's setup key). The 1.5 s "Copied" reset and the
 * blocked-clipboard fallback live here, once.
 *
 * `label` names WHAT the button copies, and it exists because a screen can now
 * hold two of these rows for one task — the Add-node dialog's desktop path shows
 * an address and a key, and two buttons that both just say "Copy" leave a screen
 * reader (and an e2e test) guessing which is which. It is OPTIONAL and sets no
 * `aria-label` when absent: every other caller in the app is a lone command on
 * its own screen, where "Copy" is already unambiguous and naming it "Copy command"
 * would only rename a control that tests and muscle memory both address by name.
 */
export function CopyCommandRow({ text, label }: { text: string; label?: string }) {
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

  return (
    <div className="flex items-center gap-2 rounded-md bg-muted p-2">
      <code className="min-w-0 flex-1 break-all font-mono text-detail">{text}</code>
      <Button
        type="button"
        variant="outline"
        size="sm"
        {...(label ? { "aria-label": copied ? `${label} copied` : `Copy ${label}` } : {})}
        onClick={() => void copy()}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
