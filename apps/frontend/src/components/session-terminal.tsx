import { stripAnsi } from "@internal/backend-errors";
import { Link } from "@tanstack/react-router";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { RotateCcw, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { LogTail } from "@/components/log-tail";
import { TerminalDropOverlay } from "@/components/terminal-drop-overlay";
import { Button } from "@/components/ui/button";
import { useTerminalUploads } from "@/hooks/use-terminal-uploads";
import { sendInput } from "@/lib/session-frames.js";
import { attachTouchScroll } from "@/lib/terminal-touch-scroll";
import { useSessionWs } from "@/lib/use-session-ws";
import type { SessionView } from "@/types/session";
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
  background: "#0f1216",
  foreground: "#e4e4e7",
  cursor: "#8b8b90",
  selectionBackground: "#3b3b40",
  activeMatch: "#5b5b64",
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

/** Live WebSocket state of the attached session. */
export interface SessionTerminalStatus {
  /** True while the session WebSocket is open */
  connected: boolean;
  /** True once the server *rejected* the attach (close code >= 4000) */
  closed: boolean;
}

/**
 * Handles onto the terminal owned by {@link SessionTerminal}, handed to the
 * caller so it can drive the terminal from outside (commands, search).
 * Re-issued every time the terminal is created, i.e. on every `active` flip
 * back to true; handles from a previous cycle are dead at that point.
 */
export interface SessionTerminalHandles {
  /** The live xterm instance */
  term: Terminal;
  /** Serialize addon (used to read the transcript) */
  serialize: SerializeAddon;
  /** Search addon (drives the transcript finder) */
  search: SearchAddon;
  /** Sends raw bytes to the session as if typed (e.g. Ctrl-D) */
  sendInput: (data: string) => void;
}

/** Props for {@link SessionTerminal}. */
export interface SessionTerminalProps {
  /** Session to attach the terminal to */
  sessionId: string;
  /**
   * The session record, which drives the "exited" panel (it reads the exit
   * code). Optional: without it that panel simply never shows.
   */
  session?: SessionView;
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
  onReady?: (handles: SessionTerminalHandles) => void;
  /**
   * Called just before the terminal is disposed, i.e. whenever the handles a
   * previous `onReady` published stop being usable. Callers that hold on to
   * them must drop them here.
   */
  onDispose?: () => void;
  /** Called whenever the session socket opens or closes */
  onStatusChange?: (status: SessionTerminalStatus) => void;
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
   * Pane-log tail rendered by the exited panel so a failed session explains
   * itself (wrong API key, bad flag…). Absent/empty shows an honest
   * "produced no output" instead of a blank box.
   */
  diagnostics?: { lines: string[]; truncated: boolean } | null;
  /** Extra buttons for the exited panel's action row (e.g. Edit profile). */
  extraActions?: ReactNode;
}

/**
 * True when the session's process has exited while the session record is still
 * marked running (awaiting a backoff restart or a manual decision).
 * @param session - The session record, or undefined while it loads
 * @returns Whether the session is in the "exited" state
 */
export function isSessionExited(session?: SessionView): boolean {
  return session?.status === "running" && session?.alive === false;
}

/**
 * True when the harness is dead and the row is kept for explanation and
 * revival: either the crashed-while-managed state ({@link isSessionExited})
 * or an explicitly terminated session. Both render the log-tail panel with
 * Restart/Delete — terminated sessions used to fall through to the bare
 * "Session is not running" fallback, leaving no way back from a revisit.
 * @param session - The session record, or undefined while it loads
 * @returns Whether the session is dead but restartable from its detail page
 */
export function isSessionDead(session?: SessionView): boolean {
  return isSessionExited(session) || session?.status === "terminated";
}

/**
 * An xterm terminal attached to one session over the session WebSocket.
 *
 * Owns the terminal lifecycle (addons, fit loop, disposal), the socket attach
 * and drag-and-drop uploads. Everything page-specific — the transcript
 * finder, the lifecycle actions — stays with the
 * caller, which drives them through {@link SessionTerminalHandles}.
 */
export function SessionTerminal({
  sessionId,
  session,
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
}: SessionTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  // Plain-text screen captured just before the terminal was disposed; shown
  // while `active` is false so a detached pane still reads as itself.
  const [snapshot, setSnapshot] = useState("");
  const [status, setStatus] = useState<SessionTerminalStatus>({ connected: false, closed: false });

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
  const sendToSessionRef = useRef<(data: string) => void>(() => {});
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
    const term = new Terminal(TERMINAL_OPTIONS);
    const fit = new FitAddon();
    term.loadAddon(fit);
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);
    serializeRef.current = serialize;
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      term.loadAddon(webgl);
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
      });
    } catch {
      // fall back to the canvas/DOM renderer
    }
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    // iPhone/iPad: xterm's own touchmove preventDefault kills the CSS pan
    // (see lib/terminal-touch-scroll.ts); this drives line-scroll instead.
    const detachTouchScroll = attachTouchScroll(term, containerRef.current);

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
      return true;
    });

    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(containerRef.current);

    // Ensure the terminal has at least one line
    term.write("");

    onReadyRef.current?.({
      term,
      serialize,
      search: searchAddon,
      sendInput: (data) => sendToSessionRef.current(data),
    });

    return () => {
      detachTouchScroll();

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
    };
  }, [active]);

  /** Records the new socket status and reports it to the caller. */
  const emitStatus = useCallback((next: SessionTerminalStatus) => {
    statusRef.current = next;
    setStatus(next);
    onStatusChangeRef.current?.(next);
  }, []);

  // Attaches the socket to the terminal created above (effects run in
  // declaration order, so the terminal already exists). Passing an empty
  // session id while detached runs the hook's cleanup — closing the socket —
  // and re-attaches to the fresh terminal when `active` returns.
  // Declared after the mount effect above so its effect runs second; the
  // effect's onReady closure reads it lazily, by which point it exists.
  const wsRef = useSessionWs(termRef, active ? sessionId : "", {
    onOpen: () => emitStatus({ connected: true, closed: statusRef.current.closed }),
    onClose: (code, _reason) => {
      // A server rejection code (4xxx) means the attach is refused (session
      // missing / not running) — a reconnect cannot succeed, so surface the
      // dead-session state. All other closes (network drops, backend restart)
      // are transient: the hook reconnects on its own and the caller's
      // "reconnecting…" pill covers the gap.
      emitStatus({ connected: false, closed: code >= 4000 });
    },
  });

  // A deliberate detach never reports a close: useSessionWs nulls its socket
  // ref before the browser delivers onclose, and then discards that close as
  // stale. Without this the last status the caller saw would stay
  // `connected: true` for a pane that has no socket at all. Declared after the
  // hook so it runs once the hook's cleanup has torn the socket down.
  useEffect(() => {
    if (active) return;
    emitStatus({ connected: false, closed: statusRef.current.closed });
  }, [active, emitStatus]);

  sendToSessionRef.current = (data) => sendInput(wsRef.current, data);

  const uploads = useTerminalUploads({ sessionId, wsRef, termRef });

  if (!active) {
    return (
      <pre className="h-full w-full overflow-hidden whitespace-pre p-2 font-mono text-[11px] text-muted-foreground">
        {snapshot}
      </pre>
    );
  }

  // Note that "no session record" is NOT the same as "no panels": a deleted
  // or unknown session id leaves the record undefined forever, and that is
  // exactly when the not-running panel has to show. Callers with their own
  // panels opt out explicitly.
  const dead = showStatePanels && isSessionDead(session);
  // `!dead` because a dead record ALSO refuses the attach: without it the
  // closed fallback renders beside the log-tail panel (two dead states, one
  // screen) and — worse — survives navigation away, blanking a running
  // session the user switched or restarted into.
  const closed = showStatePanels && status.closed && !dead;
  const rootProps = showUploads
    ? uploads.getRootProps({ className: "relative h-full w-full" })
    : { className: "relative h-full w-full" };

  return (
    <>
      {!dead && !closed && (
        <div {...rootProps}>
          <div ref={containerRef} className="h-full w-full" />
          {showUploads && (
            <TerminalDropOverlay
              isDragActive={uploads.isDragActive}
              pending={uploads.pending}
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
        <LogTail lines={diagnostics?.lines ?? []} truncated={diagnostics?.truncated} exitCode={session?.exitCode}>
          {extraActions}
          <Button variant="outline" size="sm" onClick={onRestart} disabled={restarting}>
            <RotateCcw className="h-3 w-3" /> {restarting ? "Restarting…" : "Restart"}
          </Button>
          <Button variant="destructive" size="sm" onClick={onDelete} disabled={deleting}>
            <Trash2 className="h-3 w-3" /> {deleting ? "Deleting…" : "Delete"}
          </Button>
        </LogTail>
      )}
      {closed && (
        <div className="flex h-full items-center justify-center bg-background text-muted-foreground text-sm">
          Session is not running.{" "}
          <Link to="/" className="ml-1 text-primary hover:underline">
            Back to sessions
          </Link>
        </div>
      )}
    </>
  );
}
