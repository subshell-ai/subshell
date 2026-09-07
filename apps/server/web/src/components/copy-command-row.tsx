import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * A monospace command line with a copy affordance — the shared row for any
 * block instructing the operator to run something (harness install, MCP
 * registration). The 1.5 s "Copied" reset and the blocked-clipboard fallback
 * live here, once.
 */
export function CopyCommandRow({ text }: { text: string }) {
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
      <code className="min-w-0 flex-1 break-all font-mono text-xs">{text}</code>
      <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
