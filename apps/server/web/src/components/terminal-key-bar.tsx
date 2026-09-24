import { cn } from "@internal/node-admin";
import { ArrowDownToLine, ArrowUpToLine, ImagePlus } from "lucide-react";
import type { ReactNode } from "react";

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
    // "insert a newline" (subshell-terminal maps the physical combo to this).
    { label: "⇧⏎", aria: "Insert newline", bytes: "\x1b\r" },
  ],
  [
    // A plain "/" byte — the pane's program (a shell, claude's own slash
    // commands) owns the character; subshell intercepts nothing.
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
  /** Grayed until the subshell WS is attached */
  disabled: boolean;
  /** Write raw bytes to the pane */
  onBytes: (bytes: string) => void;
  /**
   * When set (and not {@link readOnly}), the bar gains a trailing image
   * button on the second row: it opens the OS image picker (camera/photos on
   * touch devices) and the picks ride the normal upload-and-inject path.
   * This is one of the few non-byte controls on the bar, and it exists
   * because drag-and-drop and clipboard-file paste — the desktop upload
   * gestures — have no touch equivalent.
   */
  onPickImage?: () => void;
  /**
   * Jump the client terminal's scrollback to the oldest row (xterm
   * `scrollToTop`). Purely local — the bytes are already on the device — so
   * unlike the byte keys these are NOT gated on {@link disabled}: scrolling
   * history works before the socket is up, and for a `view` grantee it is
   * the whole point.
   */
  onScrollTop?: () => void;
  /** Jump the client terminal's scrollback to the live bottom. */
  onScrollBottom?: () => void;
  /**
   * A `view` grantee (spec 2026-08-31 §4.1): keystrokes would be dropped
   * server-side anyway, so the bar ships only the reading controls — the
   * scroll buttons — and no byte keys or image picker.
   */
  readOnly?: boolean;
}

const BUTTON_CLASS =
  "min-h-11 flex-1 basis-11 touch-manipulation select-none bg-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground disabled:opacity-40";

/**
 * Accessory special-key rows for touch devices (spec §5), two per {@link
 * KEY_BAR_ROWS}. Byte buttons are min-h-11 (44px) and touch-manipulation (no
 * double-tap zoom). subshell intercepts no characters; the pane's own program
 * decides what `/` or anything else means. The non-byte exceptions are the
 * trailing image button (see {@link TerminalKeyBarProps.onPickImage}) and the
 * scroll-to-top/bottom jumps (see {@link TerminalKeyBarProps.onScrollTop}).
 *
 * `onPointerDown` preventDefault pins focus wherever it is (the terminal's
 * hidden textarea) when a button is tapped — a native button would take
 * focus, and xterm stops routing keystrokes once its textarea is blurred,
 * so the next hardware key would go missing. `click` still fires normally.
 * In {@link readOnly} mode only the scroll row renders.
 *
 * The bottom padding is HALF the home-indicator inset, not all of it. The
 * indicator's VISUAL sits in roughly the bottom 15 pt (the ~21 pt below
 * that is the system's swipe zone, which claims swipes, never taps), so
 * half of a 34 pt inset still leaves the 44 pt buttons' bottom edge above
 * it — and the full inset read as a dead card band below the keys
 * (operator: "huge bottom padding"). The shell adds no bottom padding
 * under this bar — see `routeOwnsBottomEdge`.
 */
export function TerminalKeyBar({
  disabled,
  onBytes,
  onPickImage,
  onScrollTop,
  onScrollBottom,
  readOnly = false,
}: TerminalKeyBarProps) {
  const scrollButtons = (
    <>
      {onScrollTop && (
        <button
          type="button"
          aria-label="Scroll to top"
          onPointerDown={(e) => e.preventDefault()}
          onClick={onScrollTop}
          className={cn(BUTTON_CLASS, "font-mono text-sm")}
        >
          <ArrowUpToLine className="mx-auto size-4" aria-hidden="true" />
        </button>
      )}
      {onScrollBottom && (
        <button
          type="button"
          aria-label="Scroll to bottom"
          onPointerDown={(e) => e.preventDefault()}
          onClick={onScrollBottom}
          className={cn(BUTTON_CLASS, "font-mono text-sm")}
        >
          <ArrowDownToLine className="mx-auto size-4" aria-hidden="true" />
        </button>
      )}
    </>
  );
  const trailingActions: ReactNode = (
    <>
      {!readOnly && onPickImage && (
        <button
          type="button"
          disabled={disabled}
          aria-label="Attach image"
          onPointerDown={(e) => e.preventDefault()}
          onClick={onPickImage}
          className={cn(BUTTON_CLASS, "border-border/60 border-l")}
        >
          <ImagePlus className="mx-auto size-4" aria-hidden="true" />
        </button>
      )}
      {scrollButtons}
    </>
  );

  if (readOnly) {
    return (
      <div
        role="toolbar"
        aria-label="Terminal scrolling"
        className="flex shrink-0 flex-col gap-px border-border border-t bg-card pb-[calc(env(safe-area-inset-bottom)/2)]"
      >
        <div className="flex items-stretch gap-px">{trailingActions}</div>
      </div>
    );
  }

  return (
    <div
      role="toolbar"
      aria-label="Terminal special keys"
      className="flex shrink-0 flex-col gap-px border-border border-t bg-card pb-[calc(env(safe-area-inset-bottom)/2)]"
    >
      {KEY_BAR_ROWS.map((row, i) => (
        <div key={row[0].label} className="flex items-stretch gap-px overflow-x-auto">
          {row.map((b) => (
            <button
              key={b.label}
              type="button"
              disabled={disabled}
              aria-label={b.aria}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => onBytes(b.bytes)}
              className={cn(BUTTON_CLASS, "font-mono text-sm")}
            >
              {b.label}
            </button>
          ))}
          {i === KEY_BAR_ROWS.length - 1 && trailingActions}
        </div>
      ))}
    </div>
  );
}
