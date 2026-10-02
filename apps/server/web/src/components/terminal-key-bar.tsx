import { cn } from "@internal/node-admin";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronsDown,
  ChevronsUp,
  ClipboardPaste,
  Copy,
  ImagePlus,
  Keyboard,
  RefreshCw,
  TextCursorInput,
} from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

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

/** The initial group stays in the operator's requested order. */
export const KEY_BAR_ROWS: KeyBarButton[][] = [
  [
    { label: "Esc", aria: "Send Escape", bytes: "\x1b" },
    { label: "←", aria: "Send arrow left", bytes: "\x1b[D" },
    { label: "↑", aria: "Send arrow up", bytes: "\x1b[A" },
    { label: "↓", aria: "Send arrow down", bytes: "\x1b[B" },
    { label: "→", aria: "Send arrow right", bytes: "\x1b[C" },
    { label: "⏎", aria: "Send Enter", bytes: "\r" },
    { label: "⇧⏎", aria: "Insert newline", bytes: "\x1b\r" },
  ],
  [
    { label: "^C", aria: "Send Ctrl-C", bytes: "\x03" },
    { label: "⇧Tab", aria: "Send Shift-Tab", bytes: "\x1b[Z" },
    { label: "Tab", aria: "Send Tab", bytes: "\t" },
    { label: "/", aria: "Send slash", bytes: "/" },
  ],
];

/** All byte controls, in render order, with photo/scroll controls between groups. */
export const KEY_BAR_BUTTONS: KeyBarButton[] = KEY_BAR_ROWS.flat();

export interface TerminalKeyBarProps {
  /** Grayed until the subshell WS is attached */
  disabled: boolean;
  /** Write raw bytes to the pane */
  onBytes: (bytes: string) => void;
  /**
   * When set (and not {@link readOnly}), the bar gains a trailing image
   * button: it opens the OS image picker (camera/photos on
   * touch devices) and the picks ride the normal upload-and-inject path.
   * This is one of the few non-byte controls on the bar, and it exists
   * because drag-and-drop and clipboard-file paste — the desktop upload
   * gestures — have no touch equivalent.
   */
  onPickImage?: () => void;
  /** Paste text through xterm's paste path, including bracketed-paste handling. */
  onPaste?: (text: string) => void;
  /** Open the existing prompt picker and typed-not-submitted confirmation flow. */
  onInjectPrompt?: () => void;
  /** Shares the terminal's copy/input mode with the action menu. */
  copyMode?: { on: boolean; onToggle: () => void };
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
  /** Scroll the local history by one screen at a time. */
  onScrollPageUp?: () => void;
  onScrollPageDown?: () => void;
  /** Reload the entire page. */
  onRefresh?: () => void;
  /**
   * A `view` grantee (spec 2026-08-31 §4.1): keystrokes would be dropped
   * server-side anyway, so the bar ships only the reading controls — the
   * scroll buttons — and no byte keys or image picker.
   */
  readOnly?: boolean;
  /**
   * Copy mode (issue 242): input controls suppressed for the MODE, not the
   * permission. A pane in copy mode has declared "typing yields to
   * selecting", and a byte row one tap away would contradict that.
   * Deliberately NOT folded into {@link readOnly}, which names an access
   * level — the bar disables input in copy mode and hides it for view access; the two reasons
   * stay distinguishable to whoever reads this later.
   */
  suppressInput?: boolean;
}

const BUTTON_CLASS =
  "min-h-11 min-w-11 shrink-0 touch-manipulation select-none bg-transparent px-3 text-muted-foreground hover:bg-accent/50 hover:text-foreground disabled:opacity-40 data-[pressed=true]:bg-accent data-[pressed=true]:text-foreground data-[pressed=true]:shadow-inner enabled:active:bg-accent enabled:active:text-foreground motion-safe:transition-colors";

/** Preserve terminal focus and show feedback even for a quick touch tap. */
function KeyBarControl({ className, disabled, onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const [pressed, setPressed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  function press() {
    if (disabled) return;
    clearTimeout(timer.current);
    setPressed(true);
  }
  function release() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPressed(false), 160);
  }
  function cancel() {
    clearTimeout(timer.current);
    setPressed(false);
  }
  return (
    <button
      {...props}
      disabled={disabled}
      className={className}
      data-pressed={!disabled && pressed}
      onPointerDown={(event) => {
        event.preventDefault();
        press();
      }}
      onPointerUp={release}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      onBlur={cancel}
      onKeyDown={(event) => {
        if (event.key === " " || event.key === "Enter") press();
      }}
      onKeyUp={release}
      onClick={(event) => {
        if (disabled) return;
        press();
        release();
        onClick?.(event);
      }}
    />
  );
}

/**
 * One horizontally scrollable accessory row for touch devices. Byte buttons are min-h-11 (44px) and touch-manipulation (no
 * double-tap zoom). subshell intercepts no characters; the pane's own program
 * decides what `/` or anything else means. The non-byte exceptions are the
 * trailing image button (see {@link TerminalKeyBarProps.onPickImage}) and the
 * scroll-to-top/bottom jumps (see {@link TerminalKeyBarProps.onScrollTop}).
 *
 * `onPointerDown` preventDefault pins focus wherever it is (the terminal's
 * hidden textarea) when a button is tapped — a native button would take
 * focus, and xterm stops routing keystrokes once its textarea is blurred,
 * so the next hardware key would go missing. `click` still fires normally.
 * View access renders only reading controls. Copy mode keeps the full row
 * and its scroll position, disabling input controls until input resumes.
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
  onPaste,
  onInjectPrompt,
  copyMode,
  onScrollTop,
  onScrollBottom,
  onScrollPageUp,
  onScrollPageDown,
  onRefresh,
  readOnly = false,
  suppressInput = false,
}: TerminalKeyBarProps) {
  // The input half stands down for either reason: a permission (`view`) or
  // the copy-mode flag. The scroll row is reading, so it always stays.
  const inputless = readOnly || suppressInput;
  const [pasting, setPasting] = useState(false);
  const pasteTarget = useRef(onPaste);
  pasteTarget.current = disabled || inputless ? undefined : onPaste;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function pasteClipboard() {
    setPasting(true);
    try {
      if (!navigator.clipboard?.readText) {
        toast.error("Clipboard access requires HTTPS and a supported browser.");
        return;
      }
      const text = await navigator.clipboard.readText();
      if (!mounted.current || !pasteTarget.current) return;
      if (text) pasteTarget.current(text);
      else toast.error("No text on the clipboard.");
    } catch {
      if (!mounted.current) return;
      toast.error("Clipboard access was blocked. Allow paste access in your browser and try again.");
    } finally {
      if (mounted.current) setPasting(false);
    }
  }
  const scrollButtons = (onScrollTop || onScrollPageUp || onScrollPageDown || onScrollBottom) && (
    <fieldset aria-label="Terminal history" className="mx-1 flex shrink-0 items-stretch border-border/60 border-x">
      {onScrollTop && (
        <KeyBarControl type="button" aria-label="Scroll to top" onClick={onScrollTop} className={BUTTON_CLASS}>
          <ArrowUpToLine className="mx-auto size-4" aria-hidden="true" />
        </KeyBarControl>
      )}
      {onScrollPageUp && (
        <KeyBarControl type="button" aria-label="Scroll page up" onClick={onScrollPageUp} className={BUTTON_CLASS}>
          <ChevronsUp className="mx-auto size-4" aria-hidden="true" />
        </KeyBarControl>
      )}
      {onScrollPageDown && (
        <KeyBarControl type="button" aria-label="Scroll page down" onClick={onScrollPageDown} className={BUTTON_CLASS}>
          <ChevronsDown className="mx-auto size-4" aria-hidden="true" />
        </KeyBarControl>
      )}
      {onScrollBottom && (
        <KeyBarControl type="button" aria-label="Scroll to bottom" onClick={onScrollBottom} className={BUTTON_CLASS}>
          <ArrowDownToLine className="mx-auto size-4" aria-hidden="true" />
        </KeyBarControl>
      )}
    </fieldset>
  );
  const trailingActions: ReactNode = (
    <>
      {!readOnly && onPickImage && (
        <KeyBarControl
          type="button"
          disabled={disabled || inputless}
          aria-label="Attach image"
          onClick={onPickImage}
          className={cn(BUTTON_CLASS, "border-border/60 border-l")}
        >
          <ImagePlus className="mx-auto size-4" aria-hidden="true" />
        </KeyBarControl>
      )}
      {scrollButtons}
      {onRefresh && (
        <KeyBarControl type="button" aria-label="Refresh page" onClick={onRefresh} className={BUTTON_CLASS}>
          <RefreshCw className="mx-auto size-4" aria-hidden="true" />
        </KeyBarControl>
      )}
    </>
  );

  return (
    <div
      role="toolbar"
      aria-label={readOnly ? "Terminal scrolling" : "Terminal special keys"}
      className="flex min-w-0 shrink-0 flex-col gap-px border-border border-t bg-card pb-[calc(env(safe-area-inset-bottom)/2)]"
    >
      <div className="flex min-w-0 items-stretch">
        <div data-terminal-controls-scroller className="flex min-w-0 flex-1 items-stretch gap-px overflow-x-auto">
          {!readOnly &&
            KEY_BAR_ROWS[0].map((b) => (
              <KeyBarControl
                key={b.label}
                type="button"
                disabled={disabled || inputless}
                aria-label={b.aria}
                onClick={() => onBytes(b.bytes)}
                className={cn(BUTTON_CLASS, "font-mono text-sm")}
              >
                {b.label}
              </KeyBarControl>
            ))}
          {trailingActions}
          {copyMode && (
            <KeyBarControl
              type="button"
              aria-label={copyMode.on ? "Enable text input" : "Enable text copying"}
              aria-pressed={copyMode.on}
              onClick={copyMode.onToggle}
              className={cn(BUTTON_CLASS, copyMode.on && "bg-accent text-foreground")}
            >
              {copyMode.on ? (
                <Keyboard className="mx-auto size-4" aria-hidden="true" />
              ) : (
                <Copy className="mx-auto size-4" aria-hidden="true" />
              )}
            </KeyBarControl>
          )}
          {!readOnly && onPaste && (
            <KeyBarControl
              type="button"
              disabled={disabled || inputless || pasting}
              aria-label="Paste text"
              onClick={() => void pasteClipboard()}
              className={BUTTON_CLASS}
            >
              <ClipboardPaste className="mx-auto size-4" aria-hidden="true" />
            </KeyBarControl>
          )}
          {!readOnly && onInjectPrompt && (
            <KeyBarControl
              type="button"
              disabled={disabled || inputless}
              aria-label="Inject prompt"
              onClick={onInjectPrompt}
              className={BUTTON_CLASS}
            >
              <TextCursorInput className="mx-auto size-4" aria-hidden="true" />
            </KeyBarControl>
          )}
          {!readOnly &&
            KEY_BAR_ROWS[1].map((b) => (
              <KeyBarControl
                key={b.label}
                type="button"
                disabled={disabled || inputless}
                aria-label={b.aria}
                onClick={() => onBytes(b.bytes)}
                className={cn(BUTTON_CLASS, "font-mono text-sm")}
              >
                {b.label}
              </KeyBarControl>
            ))}
        </div>
      </div>
    </div>
  );
}
