import { ImagePlus } from "lucide-react";
import { cn } from "@/lib/utils";

/** One key-bar button — every button sends raw bytes, like a physical key. */
export interface KeyBarButton {
  /** Glyph printed on the button */
  label: string;
  /** Accessible name; also the test/e2e locator */
  aria: string;
  /** Raw bytes written to the pane. Plain CSI arrows (not SS3): tmux
   * translates them for whatever cursor mode the inner app set — the same
   * encoding a desktop xterm sends. */
  bytes: string;
}

/**
 * The bar renders one row per entry. Twelve buttons on one row squished the
 * glyphs into each other on a phone (and the optional image button made it
 * thirteen), so the keys are grouped into two six-wide rows: control keys on
 * top, input/navigation below — with the image button trailing the second.
 */
export const KEY_BAR_ROWS: KeyBarButton[][] = [
  [
    { label: "Esc", aria: "Send Escape", bytes: "\x1b" },
    { label: "^C", aria: "Send Ctrl-C", bytes: "\x03" },
    { label: "⇧Tab", aria: "Send Shift-Tab", bytes: "\x1b[Z" },
    { label: "Tab", aria: "Send Tab", bytes: "\t" },
    // CR is what a physical Enter sends (xterm emits "\r"), so form
    // prompts answer identically from the bar or a hardware keyboard.
    { label: "⏎", aria: "Send Enter", bytes: "\r" },
    // The touch stand-in for Shift+Enter: ESC+CR, which the harnesses read as
    // "insert a newline" (session-terminal maps the physical combo to this).
    { label: "⇧⏎", aria: "Insert newline", bytes: "\x1b\r" },
  ],
  [
    // A plain "/" byte — the pane's program (a shell, claude's own slash
    // commands) owns the character; mote intercepts nothing.
    { label: "/", aria: "Send slash", bytes: "/" },
    { label: "←", aria: "Send arrow left", bytes: "\x1b[D" },
    { label: "↑", aria: "Send arrow up", bytes: "\x1b[A" },
    { label: "↓", aria: "Send arrow down", bytes: "\x1b[B" },
    { label: "→", aria: "Send arrow right", bytes: "\x1b[C" },
  ],
];

/** Flat view of {@link KEY_BAR_ROWS}, in render order. */
export const KEY_BAR_BUTTONS: KeyBarButton[] = KEY_BAR_ROWS.flat();

export interface TerminalKeyBarProps {
  /** Grayed until the session WS is attached */
  disabled: boolean;
  /** Write raw bytes to the pane */
  onBytes: (bytes: string) => void;
  /**
   * When set, the bar gains a trailing image button on the second row: it
   * opens the OS image picker (camera/photos on touch devices) and the picks
   * ride the normal upload-and-inject path. This is the one non-byte control
   * on the bar, and it exists because drag-and-drop and clipboard-file
   * paste — the desktop upload gestures — have no touch equivalent.
   */
  onPickImage?: () => void;
}

/** Accessory special-key rows for touch devices (spec §5), two per {@link
 * KEY_BAR_ROWS}. Buttons are min-h-11 (44px) and touch-manipulation (no
 * double-tap zoom). Every button is a plain byte sender — mote intercepts no
 * characters; the pane's own program decides what `/` or anything else means.
 * The one exception is the optional trailing image button (see
 * {@link TerminalKeyBarProps.onPickImage}).
 *
 * `onPointerDown` preventDefault pins focus wherever it is (the terminal's
 * hidden textarea) when a button is tapped — a native button would take
 * focus, and xterm stops routing keystrokes once its textarea is blurred,
 * so the next hardware key would go missing. `click` still fires normally. */
export function TerminalKeyBar({ disabled, onBytes, onPickImage }: TerminalKeyBarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Terminal special keys"
      className="flex shrink-0 flex-col gap-px border-border border-t bg-card pb-[env(safe-area-inset-bottom)]"
    >
      {KEY_BAR_ROWS.map((row) => (
        <div key={row[0].label} className="flex items-stretch gap-px overflow-x-auto">
          {row.map((b) => (
            <button
              key={b.label}
              type="button"
              disabled={disabled}
              aria-label={b.aria}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => onBytes(b.bytes)}
              className={cn(
                "min-h-11 flex-1 basis-11 touch-manipulation select-none bg-transparent font-mono text-muted-foreground text-sm hover:bg-accent/50 hover:text-foreground disabled:opacity-40",
              )}
            >
              {b.label}
            </button>
          ))}
          {row === KEY_BAR_ROWS[KEY_BAR_ROWS.length - 1] && onPickImage && (
            <button
              type="button"
              disabled={disabled}
              aria-label="Attach image"
              onPointerDown={(e) => e.preventDefault()}
              onClick={onPickImage}
              className={cn(
                "min-h-11 flex-1 basis-11 touch-manipulation select-none border-border/60 border-l bg-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground disabled:opacity-40",
              )}
            >
              <ImagePlus className="mx-auto size-4" aria-hidden="true" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
