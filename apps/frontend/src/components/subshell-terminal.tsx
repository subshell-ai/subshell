import { stripAnsi } from "@internal/backend-errors";
import { Link } from "@tanstack/react-router";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";
import { RotateCcw, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { LogTail } from "@/components/log-tail";
import { TerminalDropOverlay } from "@/components/terminal-drop-overlay";
import { Button } from "@/components/ui/button";
import { useTerminalUploads } from "@/hooks/use-terminal-uploads";
import { shouldResetForeignScroll } from "@/lib/app-scroll-pin";
import { deadPanelActions } from "@/lib/dead-panel-actions";
import { sendInput } from "@/lib/subshell-frames.js";
import { TERM_FONT_EVENT, terminalFontSize } from "@/lib/terminal-font-size";
import { isPasteChord } from "@/lib/terminal-keys";
import { attachTouchScroll, attachWheelScroll, gateTouchKeyboard, isTouchUi } from "@/lib/terminal-touch-scroll";
import { useSubshellWs } from "@/lib/use-subshell-ws";
import type { SubshellView } from "@/types/subshell";
import "@xterm/xterm/css/xterm.css";

/**
 * Colours applied to every terminal instance — the single sanctioned home
 * for the terminal palette. `background` is the same value as the
 * `--terminal-strip` theme token (`bg-terminal-strip`); xterm needs a
 * literal here, so the two are kept equal by hand. `activeMatch` is the one
 * colour the terminal itself never renders — the find overlay
 * (`<TranscriptSearch>`) decorates matches in it, and reads every colour
 * from this object rather than re-hardcoding the palette.
 */
export const TERMINAL_THEME = {
  background: "#221c32", // == --terminal-strip (kept in sync by hand, see comment)
  foreground: "#e4e4e7", // neutral on purpose: code output outranks theme tint
  cursor: "#df86ed", // dreamframe orchid (oklch(0.75 0.17 322))
  selectionBackground: "#56335b",
  activeMatch: "#78497f",
} as const;

/** Terminal options shared by the full-page view and every workspace pane. */
const TERMINAL_OPTIONS = {
  cursorBlink: true,
  fontSize: 13,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  theme: TERMINAL_THEME,
  allowProposedApi: true,
  scrollback: 5000,
} as const;

/** Live WebSocket state of the attached subshell. */
export interface SubshellTerminalStatus {
  /** True while the subshell WebSocket is open */
  connected: boolean;
  /** True once the server *rejected* the attach (close code >= 4000) */
  closed: boolean;
  /**
   * True when this viewer was superseded (close 4003): the subshell is alive
   * and streaming in a NEWER viewer — one pane, one size, newest wins. Not
   * `closed`: a subshell watched elsewhere must not be reported as dead.
   */
  replaced?: boolean;
}

/**
 * Handles onto the terminal owned by {@link SubshellTerminal}, handed to the
 * caller so it can drive the terminal from outside (commands, search).
 * Re-issued every time the terminal is created, i.e. on every `active` flip
 * back to true; handles from a previous cycle are dead at that point.
 */
export interface SubshellTerminalHandles {
  /** The live xterm instance */
  term: Terminal;
  /** Serialize addon (used to read the transcript) */
  serialize: SerializeAddon;
  /** Search addon (drives the transcript finder) */
  search: SearchAddon;
  /** Sends raw bytes to the subshell as if typed (e.g. Ctrl-D) */
  sendInput: (data: string) => void;
  /** Opens the OS image picker; picks upload and inject like a dropped file */
  openImagePicker: () => void;
  /**
   * Jumps the client scrollback to the oldest row / back to the live bottom
   * (xterm `scrollToTop`/`scrollToBottom`). Local-only — works with the
   * socket down and for `view` grantees.
   */
  scrollToTop: () => void;
  /** See {@link SubshellTerminalHandles.scrollToTop}. */
  scrollToBottom: () => void;
}

/** Props for {@link SubshellTerminal}. */
export interface SubshellTerminalProps {
  /** Subshell to attach the terminal to */
  subshellId: string;
  /**
   * The subshell record, which drives the "exited" panel (it reads the exit
   * code). Optional: without it that panel simply never shows.
   */
  subshell?: SubshellView;
  /**
   * False suppresses the built-in exited / not-running panels, leaving the
   * terminal in place — for callers that render their own (workspace panes).
   * Defaults to true.
   */
  showStatePanels?: boolean;
  /**
   * False detaches the socket and disposes the terminal (releasing its WebGL
   * context), leaving a plain-text snapshot in its place. Defaults to true.
   */
  active?: boolean;
  /** False disables drag-and-drop file uploads. Defaults to true. */
  showUploads?: boolean;
  /** Called with the terminal handles each time the terminal is created */
  onReady?: (handles: SubshellTerminalHandles) => void;
  /**
   * Called just before the terminal is disposed, i.e. whenever the handles a
   * previous `onReady` published stop being usable. Callers that hold on to
   * them must drop them here.
   */
  onDispose?: () => void;
  /** Called whenever the subshell socket opens or closes */
  onStatusChange?: (status: SubshellTerminalStatus) => void;
  /**
  /** Invoked by the exited panel's Restart button */
  onRestart?: () => void;
  /** True while a restart is in flight; disables the exited panel's button */
  restarting?: boolean;
  /** Invoked by the exited panel's Delete button */
  onDelete?: () => void;
  /** True while a delete is in flight; disables the exited panel's button */
  deleting?: boolean;
  /**
   * Pane-log tail rendered by the exited panel so a failed subshell explains
   * itself (wrong API key, bad flag…). Absent/empty shows an honest
   * "produced no output" instead of a blank box.
   */
  diagnostics?: { lines: string[]; truncated: boolean } | null;
  /** Extra buttons for the exited panel's action row (e.g. Edit profile). */
  extraActions?: ReactNode;
}

/**
 * True when the subshell's process has exited while the subshell record is still
 * marked running (awaiting a backoff restart or a manual decision).
 * @param subshell - The subshell record, or undefined while it loads
 * @returns Whether the subshell is in the "exited" state
 */
export function isSubshellExited(subshell?: SubshellView): boolean {
  return subshell?.status === "running" && subshell?.alive === false;
}

/**
 * True when the harness is dead and the row is kept for explanation and
 * revival: either the crashed-while-managed state ({@link isSubshellExited})
 * or an explicitly terminated subshell. Both render the log-tail panel with
 * Restart/Close — terminated subshells used to fall through to the bare
 * "Subshell is not running" fallback, leaving no way back from a revisit.
 * @param subshell - The subshell record, or undefined while it loads
 * @returns Whether the subshell is dead but restartable from its detail page
 */
export function isSubshellDead(subshell?: SubshellView): boolean {
  return isSubshellExited(subshell) || subshell?.status === "terminated";
}

/**
 * An xterm terminal attached to one subshell over the subshell WebSocket.
 *
 * Owns the terminal lifecycle (addons, fit loop, disposal), the socket attach
 * and drag-and-drop uploads. Everything page-specific — the transcript
 * finder, the lifecycle actions — stays with the
 * caller, which drives them through {@link SubshellTerminalHandles}.
 */
export function SubshellTerminal({
  subshellId,
  subshell,
  showStatePanels = true,
  active = true,
  showUploads = true,
  onReady,
  onDispose,
  onStatusChange,
  onRestart,
  restarting = false,
  onDelete,
  deleting = false,
  diagnostics = null,
  extraActions,
}: SubshellTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  // Live FitAddon for the WS hook: it re-measures right before the attach
  // URL carries the grid size (a stale size captures mis-wrapped rows).
  const fitRef = useRef<FitAddon | null>(null);
  const measureGrid = useCallback(() => fitRef.current?.fit(), []);
  // Plain-text screen captured just before the terminal was disposed; shown
  // while `active` is false so a detached pane still reads as itself.
  const [snapshot, setSnapshot] = useState("");
  const [status, setStatus] = useState<SubshellTerminalStatus>({ connected: false, closed: false });

  // Sync copies of the callbacks: the xterm key handler and the WS handlers
  // are bound once per terminal, so they must read the latest props without
  // rebinding (and without re-creating the terminal).
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onDisposeRef = useRef(onDispose);
  onDisposeRef.current = onDispose;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  // Current status, readable from the WS callbacks without closing over the
  // render they were created in.
  const statusRef = useRef(status);
  // Writes to the live socket. Kept behind a ref so the mount effect below
  // never has to read the socket itself (which would make it a dependency and
  // re-create the terminal on every reconnect); it is re-pointed at the
  // current socket ref on every render, and reads it at call time.
  const sendToSubshellRef = useRef<(data: string) => void>(() => {});
  // Assigned every render below the uploads hook; the onReady handle forwards
  // to it so the closure captured at terminal-setup time never goes stale.
  const openImagePickerRef = useRef<() => void>(() => {});
  // Distinguishes an `active` flip (the component stays mounted, so the
  // snapshot has somewhere to render) from a real unmount. Declared before
  // the terminal effect so its cleanup runs first on unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Mount xterm. Re-runs on every `active` flip: false tears the terminal
  // down — which is what releases the WebGL context — and true builds a fresh
  // one, which the WS effect below then re-attaches to.
  useEffect(() => {
    if (!active) return;
    // The snapshot only exists to stand in for a detached terminal; holding
    // it past re-activation would keep one serialized screen per pane alive
    // for as long as the workspace is open.
    setSnapshot("");
    if (!containerRef.current || termRef.current) return;
    // Per-device text size (see lib/terminal-font-size): phones and desktops
    // keep their own choice; TERMINAL_OPTIONS carries the rest verbatim.
    const term = new Terminal({ ...TERMINAL_OPTIONS, fontSize: terminalFontSize() });
    const fit = new FitAddon();
    term.loadAddon(fit);
    fitRef.current = fit;
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);
    serializeRef.current = serialize;
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    // NO renderer addon — xterm 6's own DOM renderer, deliberately (2026-09-04).
    // Neither third-party renderer supports this core: `@xterm/addon-canvas`
    // (every release through 0.8.0-beta.48) and `@xterm/addon-webgl` both
    // peer-require `@xterm/xterm@^5`, and under 6.0.0 the canvas addon crashed
    // the page with `undefined is not an object (evaluating
    // 'this._linkifier2.onShowLinkUnderline')` — xterm 6 moved the linkifier
    // behind a lazily-populated holder, and a renderer built against the v5
    // shape reads it as undefined. The failure was invisible for a long time
    // because `open()` wraps its `onWillOpen` fire in `try {} catch {}`: a
    // throwing renderer addon is SWALLOWED, xterm quietly installs its own DOM
    // renderer, and only the dispose path (navigating between subshells)
    // surfaced the throw. So the earlier "WebGL → canvas" swap never actually
    // put a canvas renderer on screen; the stale-cell reports it was chasing
    // were the replay cursor misalignment fixed server-side in
    // `ws/capture-text.ts`.
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    // iPhone/iPad: xterm's own touchmove preventDefault kills the CSS pan
    // (see lib/terminal-touch-scroll.ts); this drives line-scroll instead.
    const detachTouchScroll = attachTouchScroll(term, containerRef.current);
    // iPad Magic Keyboard: the trackpad emits wheel, not touch — and xterm
    // only consumes wheel when the inner app asks for mouse reporting, so an
    // unconsumed one scrolls the PWA shell. Bridge it to the buffer.
    const detachWheelScroll = attachWheelScroll(term, containerRef.current);
    // Tap = type (keyboard), swipe/scrollbar-drag = read (no keyboard) —
    // see lib/terminal-touch-scroll.ts for why xterm needs un-focusing.
    const detachTouchKeyboard = gateTouchKeyboard(term, containerRef.current);

    // Shift+Enter must insert a newline at the harness prompt (Claude Code
    // reads ESC+CR — the very sequence its /terminal-setup keybinding emits
    // in iTerm/VS Code). xterm.js has no Shift+Enter encoding of its own,
    // so unhandled it sends a bare \r: the line submits instead of wrapping.
    // input() re-enters the bytes through the normal data path (straight to
    // the pane over the WS); returning false keeps xterm from ALSO sending
    // its own Enter.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        term.input("\x1b\r");
        return false;
      }
      // Ctrl/Cmd+V is a PASTE, not input: xterm would encode it as \x16 and
      // send it to the pane, where the harness CLI treats it as its own
      // paste shortcut and reads the SERVER's clipboard — "No image found in
      // clipboard. Use ctrl+v to paste images." on the user's machine, with
      // their actual image never leaving the browser (2026-09-02 report).
      //
      // Returning false only stops xterm's ENCODING: it bails before
      // `preventDefault`, so the browser still runs its paste pipeline and
      // fires the `paste` event — which is what does the real work either
      // way (xterm's own textarea listener writes pasted TEXT; the
      // capture-phase interceptor in use-terminal-uploads claims IMAGES).
      // Deliberate trade: a literal \x16 (SYN) can no longer be typed into a
      // pane, which is the same bargain every terminal emulator that binds
      // Ctrl+V to paste has already made.
      if (e.type === "keydown" && isPasteChord(e)) return false;
      return true;
    });

    const container = containerRef.current;
    // Touch only: opening/closing the soft keyboard shrinks this container,
    // and xterm leaves its viewport scrollTop pointing where it was in the
    // TALLER buffer — below the shrunken content. The prompt + cursor are
    // then "lost": off-screen in a blank area, and focus may have been
    // dropped with them (iOS drops the helper textarea mid-typing when it
    // pans the page to satisfy its keyboard-placement heuristics). Re-pin to
    // the bottom and hand focus back to the pane's input target. Desktop is
    // deliberately untouched: a window resize must not yank a reader out of
    // scrollback they scrolled up to study.
    // "Keyboard is up" by viewport geometry: iOS shrinks the visual
    // viewport by the keyboard's height when it opens. ~120 px is well past
    // any URL-bar chore and well under any real keyboard.
    const keyboardOpen = () => {
      const v = window.visualViewport;
      return !!v && window.innerHeight - v.height > 120;
    };
    const repairCursorVisibility = () => {
      if (!isTouchUi()) return;
      term.scrollToBottom();
      const active = document.activeElement;
      // Refocus only for a keyboard session that is actually RUNNING:
      // focus still inside the terminal (reassert after the layout churn) or
      // lost to the body while the keyboard is up (iOS's mid-typing drop).
      // An IDLE pan (keyboard down, focus nowhere) must NOT yank focus into
      // the terminal: this handler runs from visualViewport SCROLL events,
      // which every finger pan fires, and a focus() during a touch turn is
      // exactly what shows a keyboard — the "any touch pops the keyboard"
      // report (2026-09-04).
      if (container.contains(active)) term.focus();
      else if ((!active || active === document.body) && keyboardOpen()) term.focus();
    };
    const ro = new ResizeObserver(() => {
      fit.fit();
      repairCursorVisibility();
    });
    // Live re-apply when the Settings card changes the size: xterm takes
    // option changes without a grid rebuild; the refit re-derives columns.
    const onFontSetting = (e: Event) => {
      const size = (e as CustomEvent<number>).detail;
      if (typeof size === "number" && size > 0) {
        term.options.fontSize = size;
        fit.fit();
      }
    };
    window.addEventListener(TERM_FONT_EVENT, onFontSetting);
    ro.observe(container);
    // iOS pans the visual viewport mid-typing WITHOUT resizing any container
    // (no RO event), and that pan is exactly when it likes to drop focus.
    const vv = isTouchUi() ? window.visualViewport : null;
    if (vv) {
      vv.addEventListener("resize", repairCursorVisibility);
      vv.addEventListener("scroll", repairCursorVisibility);
    }
    // The "loses the cursor right after SPACE" case: iOS autocorrect commits
    // the just-typed word when space is pressed, and Safari blurs xterm's
    // helper textarea as part of that composition commit — the keyboard
    // stays up, but the terminal's input target is gone and every following
    // keystroke goes nowhere (no resize fires, so the repair above cannot
    // see it). Reclaim focus while the blur is still the page's only event:
    // Safari honors a synchronous-ish refocus, and the rAF lets its blur
    // dance finish first. An intentional focus move (Find bar, dialog,
    // another control) carries a relatedTarget and is left alone; closing
    // the keyboard lands here and only restores the cursor — iOS will not
    // re-show the keyboard without a fresh tap, which is the right outcome.
    // iOS brings the focused input "into view" by scrolling its ancestor
    // scrollers — mid-typing, classically the instant space commits
    // autocorrect — and scrollIntoView happily spends `overflow: hidden`
    // ancestors too. Those containers are invisible scrollers: a swipe can
    // never undo them, only the keyboard closing (layout reset) does — which
    // is exactly the reported behavior ("jumps on space, typing works
    // blindly, swipe does nothing, close keyboard restores"). Capture-phase
    // listener so EVERY scroller is seen, document included; anything
    // outside the terminal gets pinned to its origin while the keyboard is
    // up and the terminal holds focus.
    const onAnyScroll = (e: Event) => {
      const t = e.target;
      const focus = document.activeElement;
      if (
        shouldResetForeignScroll({
          touchUi: isTouchUi(),
          // Engaged = typing (focus in the terminal) or idle (focus nowhere) —
          // the idle half undoes pans that survive the keyboard closing.
          engaged: container.contains(focus) || !focus || focus === document.body,
          insideTerminal: t instanceof Element && container.contains(t),
        })
      ) {
        if (t === document) {
          window.scrollTo(0, 0);
          return;
        }
        if (t instanceof Element) {
          t.scrollTop = 0;
          t.scrollLeft = 0;
        }
      }
    };
    window.addEventListener("scroll", onAnyScroll, true);
    const onFocusOut = (e: FocusEvent) => {
      if (!isTouchUi() || e.relatedTarget) return;
      requestAnimationFrame(() => {
        // Only the mid-typing blur (keyboard still up) gets reclaimed —
        // a blur to the body with the keyboard down is the user leaving
        // input mode (or the swipe gate un-focusing), not a loss to repair.
        if (container.isConnected && document.activeElement === document.body && keyboardOpen()) term.focus();
      });
    };
    container.addEventListener("focusout", onFocusOut);

    // Ensure the terminal has at least one line
    term.write("");

    onReadyRef.current?.({
      term,
      serialize,
      search: searchAddon,
      sendInput: (data) => sendToSubshellRef.current(data),
      openImagePicker: () => openImagePickerRef.current(),
      scrollToTop: () => term.scrollToTop(),
      scrollToBottom: () => term.scrollToBottom(),
    });

    return () => {
      detachTouchScroll();
      detachWheelScroll();
      detachTouchKeyboard();
      if (vv) {
        vv.removeEventListener("resize", repairCursorVisibility);
        vv.removeEventListener("scroll", repairCursorVisibility);
      }
      window.removeEventListener("scroll", onAnyScroll, true);
      window.removeEventListener(TERM_FONT_EVENT, onFontSetting);
      container.removeEventListener("focusout", onFocusOut);
      ro.disconnect();
      // Only a detach leaves the component mounted to show the snapshot; on a
      // real unmount there is nothing left to render it into.
      if (mountedRef.current) setSnapshot(stripAnsi(serialize.serialize()));
      // Everything published by onReady dies with the terminal, so tell the
      // caller before it does.
      onDisposeRef.current?.();
      term.dispose();
      termRef.current = null;
      serializeRef.current = null;
      fitRef.current = null;
    };
  }, [active]);

  /** Records the new socket status and reports it to the caller. */
  const emitStatus = useCallback((next: SubshellTerminalStatus) => {
    statusRef.current = next;
    setStatus(next);
    onStatusChangeRef.current?.(next);
  }, []);

  // Attaches the socket to the terminal created above (effects run in
  // declaration order, so the terminal already exists). Passing an empty
  // subshell id while detached runs the hook's cleanup — closing the socket —
  // and re-attaches to the fresh terminal when `active` returns.
  // Declared after the mount effect above so its effect runs second; the
  // effect's onReady closure reads it lazily, by which point it exists.
  const wsRef = useSubshellWs(
    termRef,
    active ? subshellId : "",
    {
      onOpen: () => emitStatus({ connected: true, closed: statusRef.current.closed }),
      onClose: (code, _reason) => {
        // 4003: a NEWER viewer took the subshell (one pane has one width; the
        // newest viewer owns it). The subshell is alive — say so, do not
        // render the dead-subshell state, and the hook will not retry.
        if (code === 4003) {
          emitStatus({ connected: false, closed: false, replaced: true });
          return;
        }
        // A server rejection code (4xxx) means the attach is refused (subshell
        // missing / not running) — a reconnect cannot succeed, so surface the
        // dead-subshell state. All other closes (network drops, backend restart)
        // are transient: the hook reconnects on its own and the caller's
        // "reconnecting…" pill covers the gap.
        emitStatus({ connected: false, closed: code >= 4000 });
      },
    },
    // A `view` grantee watches the pane but cannot type (spec §4.1).
    subshell?.access === "view",
    // Re-fit before the attach URL commits to a grid size.
    measureGrid,
  );

  // A deliberate detach never reports a close: useSubshellWs nulls its socket
  // ref before the browser delivers onclose, and then discards that close as
  // stale. Without this the last status the caller saw would stay
  // `connected: true` for a pane that has no socket at all. Declared after the
  // hook so it runs once the hook's cleanup has torn the socket down.
  useEffect(() => {
    if (active) return;
    emitStatus({ connected: false, closed: statusRef.current.closed });
  }, [active, emitStatus]);

  sendToSubshellRef.current = (data) => sendInput(wsRef.current, data);

  const uploads = useTerminalUploads({ subshellId, wsRef, termRef, enabled: showUploads });
  openImagePickerRef.current = uploads.openImagePicker;

  if (!active) {
    return (
      <pre className="h-full w-full overflow-hidden whitespace-pre p-2 font-mono text-[11px] text-muted-foreground">
        {snapshot}
      </pre>
    );
  }

  // Note that "no subshell record" is NOT the same as "no panels": a deleted
  // or unknown subshell id leaves the record undefined forever, and that is
  // exactly when the not-running panel has to show. Callers with their own
  // panels opt out explicitly.
  const dead = showStatePanels && isSubshellDead(subshell);
  // `!dead` because a dead record ALSO refuses the attach: without it the
  // closed fallback renders beside the log-tail panel (two dead states, one
  // screen) and — worse — survives navigation away, blanking a running
  // subshell the user switched or restarted into.
  const closed = showStatePanels && status.closed && !dead;
  const rootProps = showUploads
    ? uploads.getRootProps({ className: "relative h-full w-full" })
    : { className: "relative h-full w-full" };

  return (
    <>
      {!dead && !closed && (
        // rootRef (from the dropzone hook) scopes the clipboard-paste
        // interceptor's focus test to THIS terminal — see use-terminal-uploads.
        <div {...rootProps} ref={uploads.rootRef as React.RefObject<HTMLDivElement | null>}>
          <div ref={containerRef} className="h-full w-full" />
          {showUploads && (
            <TerminalDropOverlay
              isDragActive={uploads.isDragActive}
              entries={uploads.entries}
              error={uploads.error}
              onDismiss={uploads.dismissError}
            />
          )}
        </div>
      )}
      {/* The pane log's tail is the only record of why a harness that died
          before anyone attached bailed out — `<LogTail>` renders headline,
          actions and scrollable log in the shared shape. */}
      {dead && (
        <LogTail lines={diagnostics?.lines ?? []} truncated={diagnostics?.truncated} exitCode={subshell?.exitCode}>
          {extraActions}
          {/* Same access contract the actions menu enforces (spec §4.1):
              `edit` revives, only the `owner` may Close (delete). Without this
              gate the panel offered both buttons on foreign rows — an `edit`
              viewer's Close 404s, exactly the dead end the menu already hides
              (a missing record keeps both, matching the menu's owner default
              while a mid-view delete is being observed). */}
          {deadPanelActions(subshell?.access).restart && (
            <Button variant="outline" size="sm" onClick={onRestart} disabled={restarting}>
              <RotateCcw className="h-3 w-3" /> {restarting ? "Restarting…" : "Restart"}
            </Button>
          )}
          {deadPanelActions(subshell?.access).close && (
            <Button variant="destructive" size="sm" onClick={onDelete} disabled={deleting}>
              <X className="h-3 w-3" /> {deleting ? "Closing…" : "Close"}
            </Button>
          )}
        </LogTail>
      )}
      {closed && (
        <div className="flex h-full items-center justify-center bg-background text-muted-foreground text-sm">
          Subshell is not running.{" "}
          <Link to="/" className="ml-1 text-primary hover:underline">
            Back to subshells
          </Link>
        </div>
      )}
    </>
  );
}
