import { relativeElapsed } from "@internal/node-admin";
import { describeDevices, type ViewersState } from "@internal/subshell-protocol";
import type { JSX } from "react";
import { useClockTick } from "@/hooks/use-clock-tick";
import { useLiveInputQueue } from "@/hooks/use-input-queue-live";
import { type InputQueue, type InputQueueStats, queueBadgeView, type RttSamples } from "@/lib/input-queue";
import { INDICATOR_LABEL, subshellIndicator } from "@/lib/subshell-indicator";
import type { SubshellView } from "@/types/subshell";

/**
 * The pane diagnostics HUD (spec 2026-09-21 Wave C): one dense overlay over
 * the terminal answering the questions an operator asks when typing lags.
 * Every row is derived client-side from state the page already holds; there
 * is no new server surface, no second socket, and no polling loop beyond the
 * ONE one-second clock tick that keeps the ages honest.
 *
 * Styled like the input badge and the devices strip (floated, dense,
 * `text-detail`, the same plate), and stacked BELOW the badge in the same
 * corner by the terminal, so the two never fight for the same pixels.
 */

/** Short duration for RTT and stall figures: milliseconds under a second, then one decimal of seconds. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** The attach socket's state word. `closed` is a server REFUSAL (4xxx close); everything else that is not open is the reconnect loop. */
export function socketWord(socket: { connected: boolean; closed: boolean }): string {
  if (socket.closed) return "closed";
  return socket.connected ? "open" : "reconnecting";
}

/**
 * The pane-to-tmux word: alive, or exited with the harness's exit code when
 * the row carries one. Unknown only while the record has not arrived.
 */
export function paneWord(subshell: SubshellView | undefined): string {
  if (!subshell) return "unknown";
  if (subshell.alive) return "alive";
  return subshell.exitCode === null ? "exited" : `exited (code ${subshell.exitCode})`;
}

/** The output-age word, on the shared `relativeElapsed` clock every other list uses. */
export function outputAgeWord(subshell: SubshellView | undefined): string {
  if (!subshell) return "unknown";
  if (!subshell.lastOutputAt) return "none yet";
  const age = relativeElapsed(subshell.lastOutputAt);
  return age === "just now" ? age : `${age} ago`;
}

/** The viewers word: who is attached and the grid they settled on, in the devices strip's own terms. */
export function viewersWord(viewers: ViewersState | null): string {
  if (!viewers) return "socket down";
  const { grid, settled } = describeDevices(viewers);
  const count = `${viewers.viewers.length} device${viewers.viewers.length === 1 ? "" : "s"}`;
  return grid && settled ? `${count} · ${grid.cols}×${grid.rows}` : `${count} · measuring…`;
}

/**
 * The input row's two lines: the numbers on the main line, the echo and
 * stall figures on a muted detail line. `engaged` is null when there is no
 * queue at all (no attach yet); false is the older-server answer where input
 * rides bare and no ack will ever come, which is a diagnostic in itself.
 */
export function inputWords(args: {
  hasQueue: boolean;
  stats: InputQueueStats;
  rtt: RttSamples;
  engaged: boolean | null;
}): { main: string; detail: string | null } {
  if (!args.hasQueue) return { main: "unknown", detail: null };
  const mainParts: string[] = [];
  if (args.stats.depth === 0) mainParts.push("idle");
  else {
    mainParts.push(`${args.stats.inFlight} in flight`);
    if (args.stats.backlog > 0) mainParts.push(`${args.stats.backlog} waiting`);
  }
  if (args.engaged === false) mainParts.push("no acks");
  const detailParts: string[] = [];
  if (args.rtt.count > 0 && args.rtt.p50 !== null && args.rtt.max !== null) {
    detailParts.push(`echo p50 ${formatMs(args.rtt.p50)} · max ${formatMs(args.rtt.max)}`);
  }
  if (args.stats.unackedOldestMs !== null) {
    detailParts.push(`oldest ${formatMs(args.stats.unackedOldestMs)} unacked`);
  }
  return { main: mainParts.join(" · "), detail: detailParts.length > 0 ? detailParts.join(" · ") : null };
}

/** Props for {@link PaneDiagnosticsHud}. */
export interface PaneDiagnosticsHudProps {
  /** The subshell row (live feed); undefined while the record has not arrived. */
  subshell?: SubshellView;
  /** The attach socket's state, as the terminal tracks it. */
  socket: { connected: boolean; closed: boolean };
  /** Reconnects this attach session has made (a ref the WS hook owns). */
  reconnectsRef: { current: number };
  /** The attach's input queue (a ref the WS hook owns). */
  inputQueueRef: { current: InputQueue | null };
  /** The latest `viewers` frame, or null while the socket is down. */
  viewers: ViewersState | null;
  /** The node's label, resolved by the page; null while unknown. */
  nodeLabel: string | null;
}

/**
 * One label/value pair of the HUD. The label is the row's name, muted; the
 * value is the answer, in the shared `text-detail` size.
 */
function Row({ label, value, warning }: { label: string; value: string; warning?: boolean }): JSX.Element {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className={warning ? "text-warning" : undefined}>{value}</span>
    </>
  );
}

export function PaneDiagnosticsHud({
  subshell,
  socket,
  reconnectsRef,
  inputQueueRef,
  viewers,
  nodeLabel,
}: PaneDiagnosticsHudProps): JSX.Element {
  // Ages (output, stall) are functions of the clock, not of a frame, so the
  // HUD keeps ONE tick while it is open and none of its rows ticks alone.
  useClockTick(1000);
  const { queue, stats, rtt } = useLiveInputQueue(inputQueueRef);
  const reconnects = reconnectsRef.current;
  const socketValue =
    reconnects > 0
      ? `${socketWord(socket)} · ${reconnects} reconnect${reconnects === 1 ? "" : "s"}`
      : socketWord(socket);
  // The pane word is the row's own fact; the indicator word is the SHARED
  // one (the same computation the dot and the cards read), so the HUD can
  // never disagree with the rest of the app about the state. Shown only
  // when it adds something the pane word does not already say.
  const pane = paneWord(subshell);
  const indicator = subshell ? INDICATOR_LABEL[subshellIndicator(subshell)] : null;
  const paneBase = subshell ? (subshell.alive ? "alive" : "exited") : "unknown";
  const paneValue = indicator && indicator !== paneBase ? `${pane} · ${indicator}` : pane;
  const nodeValue =
    subshell?.nodeOffline === true ? `${nodeLabel ?? "unknown node"} · unreachable` : (nodeLabel ?? "unknown node");
  const input = inputWords({ hasQueue: queue !== null, stats, rtt, engaged: queue ? queue.engaged : null });
  const stalled = queueBadgeView(stats).stalled;

  return (
    <div className="pointer-events-none w-max max-w-[16rem] rounded-md bg-terminal-strip/85 px-2 py-1.5 text-detail backdrop-blur-sm">
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <Row label="Socket" value={socketValue} />
        <Row label="Node" value={nodeValue} />
        <Row label="Pane" value={paneValue} />
        <Row label="Output" value={outputAgeWord(subshell)} />
        <Row label="Input" value={input.main} warning={stalled} />
        {input.detail && <span className="col-span-2 text-muted-foreground">{input.detail}</span>}
        <Row label="Viewers" value={viewersWord(viewers)} />
      </div>
    </div>
  );
}
