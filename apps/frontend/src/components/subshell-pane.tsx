import { RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { LogTail } from "@/components/log-tail";
import { SubshellTerminal, type SubshellTerminalHandles } from "@/components/subshell-terminal";
import { TerminalKeyBar } from "@/components/terminal-key-bar";
import { Button } from "@/components/ui/button";
import { useIsCoarsePointer } from "@/hooks/use-is-coarse-pointer";
import { useSubshellLog } from "@/hooks/use-subshell-log";
import type { WorkspacePaneRow } from "@/types/workspace";

/** Props for {@link SubshellPane}. */
export interface SubshellPaneProps {
  /** The pane row, with its subshell's summary joined in */
  pane: WorkspacePaneRow;
  /** False for a background tab; forwarded to the terminal's `active` */
  active: boolean;
  /**
   * True for the workspace's ACTIVE pane — on coarse-pointer devices it
   * gains the accessory key bar (bytes, image pick, scroll jumps) under its
   * terminal, the touch stand-in for the desktop keyboard. Ignored on fine
   * pointers, where the real keyboard wins.
   */
  showKeyBar?: boolean;
  /** Restarts the pane's subshell (exited/terminated only) */
  onRestart: (subshellId: string) => void;
  /** Removes the pane from the workspace, leaving the subshell alone */
  onRemovePane: (paneId: string) => void;
  /**
   * Forwarded to the underlying `SubshellTerminal`'s `onReady`, republished
   * each time the terminal is (re-)created — a caller that wants to drive the
   * terminal from outside (e.g. the maximized header's transcript finder)
   * holds the handles from here rather than reaching into the terminal.
   */
  onReady?: (handles: SubshellTerminalHandles) => void;
  /** Forwarded to the underlying `SubshellTerminal`'s `onDispose`. */
  onDispose?: () => void;
}

/**
 * The content of one dockview panel: a live terminal, or a compact panel when
 * the subshell is no longer running.
 *
 * `active` comes from dockview's visibility, so a background tab detaches its
 * socket and releases its WebGL context — the same benefit the canvas's
 * viewport virtualization provided, with a far simpler rule.
 */
export function SubshellPane({
  pane,
  active,
  showKeyBar = false,
  onRestart,
  onRemovePane,
  onReady,
  onDispose,
}: SubshellPaneProps) {
  const exited = pane.subshellStatus === "running" && !pane.subshellAlive;
  const gone = exited || pane.subshellStatus === "terminated";
  // Spec §5.6 precedence, the pane-surface twin of the home cards: while the
  // node is away the process state is UNOBSERVABLE, not dead — neither an
  // alive row (no attach possible) nor a stale exited stamp gets to decide
  // what this pane claims about reality.
  const nodeOffline = pane.subshellNodeOffline === true && pane.subshellStatus === "running";
  // A crashed subshell explains itself even in a pane: fetch the pane log's
  // tail for the exited state only (terminated was deliberate — no inquest).
  const { data: logTail } = useSubshellLog(pane.subshellId, exited);

  // Touch key bar: the buttons drive THIS pane's terminal, so the handles and
  // the socket state stay local — captured from `onReady` (and dropped on
  // dispose) beside the forwarding the maximized header's finder needs.
  const coarse = useIsCoarsePointer();
  const handlesRef = useRef<SubshellTerminalHandles | null>(null);
  const [connected, setConnected] = useState(false);
  const handleReady = useCallback(
    (handles: SubshellTerminalHandles) => {
      handlesRef.current = handles;
      onReady?.(handles);
    },
    [onReady],
  );
  const handleDispose = useCallback(() => {
    handlesRef.current = null;
    setConnected(false);
    onDispose?.();
  }, [onDispose]);

  // Shared two-button row the exited and ended panels both offer.
  const paneActions = (
    <>
      <Button variant="outline" size="sm" onClick={() => onRestart(pane.subshellId)}>
        <RotateCcw className="h-3 w-3" /> Restart
      </Button>
      <Button variant="ghost" size="sm" onClick={() => onRemovePane(pane.id)}>
        <Trash2 className="h-3 w-3" /> Remove pane
      </Button>
    </>
  );

  // Node away: say what is actually known — the machine is unreachable and
  // the daemon is dialing back; the pane may well be running there. No
  // Restart (the server 409s it while the node is offline); Remove pane
  // stays, the one honest local act.
  if (nodeOffline) {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="flex shrink-0 flex-col items-center gap-2 py-3 text-center">
          <p className="text-muted-foreground text-sm">Node offline — reconnecting</p>
          <p className="text-muted-foreground text-xs">
            This subshell may still be running on its node. Output and input resume when the node reconnects to the
            server.
          </p>
          <Button variant="ghost" size="sm" onClick={() => onRemovePane(pane.id)}>
            <Trash2 className="h-3 w-3" /> Remove pane
          </Button>
        </div>
      </div>
    );
  }

  // Exited: the shared full-page panel — headline, the pane's own two
  // actions, and the scrollable log tail (the compact variant silently
  // clipped to 20 lines and dropped the truncation note).
  if (exited) {
    return (
      <LogTail lines={logTail?.lines ?? []} truncated={logTail?.truncated} exitCode={pane.subshellExitCode}>
        {paneActions}
      </LogTail>
    );
  }

  // Terminated was deliberate — no inquest, so no log area.
  if (gone) {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="flex shrink-0 flex-col items-center gap-2 py-3 text-center">
          <p className="text-muted-foreground text-sm">Subshell ended</p>
          <div className="flex items-center gap-2">{paneActions}</div>
        </div>
      </div>
    );
  }

  {
    /* showStatePanels={false}: this component owns the non-running states
      above, so the terminal must not render a second, larger set. */
  }
  const terminal = (
    <SubshellTerminal
      subshellId={pane.subshellId}
      active={active}
      showUploads
      showStatePanels={false}
      onReady={handleReady}
      onDispose={handleDispose}
      onStatusChange={(status) => setConnected(status.connected)}
    />
  );

  if (!showKeyBar || !coarse) {
    return <div className="h-full w-full bg-terminal-strip">{terminal}</div>;
  }
  // The active pane's touch chrome: the terminal keeps the space the bar
  // takes (its ResizeObserver refits), and the bar sits under THIS pane —
  // the one the user is typing into. Byte keys gray out until the socket
  // attaches; the scroll jumps drive the local scrollback and never do.
  return (
    <div className="flex h-full w-full flex-col bg-terminal-strip">
      <div className="min-h-0 flex-1">{terminal}</div>
      <TerminalKeyBar
        disabled={!connected}
        onBytes={(bytes) => handlesRef.current?.sendInput(bytes)}
        onPickImage={() => handlesRef.current?.openImagePicker()}
        onScrollTop={() => handlesRef.current?.scrollToTop()}
        onScrollBottom={() => handlesRef.current?.scrollToBottom()}
      />
    </div>
  );
}
