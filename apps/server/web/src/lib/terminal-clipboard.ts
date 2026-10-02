import type { Terminal } from "@xterm/xterm";
import { toast } from "sonner";

/** Bound remote clipboard requests before allocating their decoded bytes. */
export const MAX_CLIPBOARD_BYTES = 1024 * 1024;

export function decodeClipboardRequest(data: string): string | null {
  const separator = data.indexOf(";");
  if (separator < 0) return null;
  const selection = data.slice(0, separator);
  // Empty defaults to the clipboard. Never answer clipboard-read queries.
  if (selection !== "" && !/^[cpsq0-7]+$/.test(selection)) return null;
  const encoded = data.slice(separator + 1);
  if (!encoded || encoded === "?" || encoded.length > Math.ceil(MAX_CLIPBOARD_BYTES / 3) * 4) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  try {
    const binary = atob(encoded);
    if (binary.length > MAX_CLIPBOARD_BYTES) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Terminal output can request a copy, but only a browser gesture performs it. */
export function attachTerminalClipboard(term: Pick<Terminal, "parser">): () => void {
  let alive = true;
  let notification: string | number | undefined;
  const handler = term.parser.registerOscHandler(52, (data) => {
    const text = decodeClipboardRequest(data);
    if (text === null) return true;
    notification = toast.message("Terminal text is ready to copy", {
      id: notification,
      description: "Copy it to this device’s clipboard.",
      duration: 30_000,
      action: {
        label: "Copy",
        onClick: () => {
          if (!alive) return;
          if (!navigator.clipboard?.writeText) {
            toast.error("Clipboard access requires HTTPS and a supported browser.");
            return;
          }
          void navigator.clipboard.writeText(text).then(
            () => {
              if (alive) toast.success("Copied to this device’s clipboard.");
            },
            () => {
              if (alive)
                toast.error(
                  "Clipboard access was blocked. Select the terminal text and use your browser’s copy shortcut.",
                );
            },
          );
        },
      },
    });
    return true;
  });
  return () => {
    alive = false;
    handler.dispose();
    if (notification !== undefined) toast.dismiss(notification);
  };
}
