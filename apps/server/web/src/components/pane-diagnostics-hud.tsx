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
export function viewersWord(viewers: ViewersState | null, socket: { connected: boolean; closed: boolean }): string {
  // No frame yet is NOT "socket down": the first `viewers` frame follows the
  // replay, and a reconnecting socket has none either. "Socket down" is the
  // one state where no frame CAN come: the server refused the attach.
  if (!viewers) return socket.closed ? "socket down" : "settling";
  const { grid, settled } = describeDevices(viewers);
  const count = `${viewers.viewers.length} device${viewers.viewers.length === 1 ? "" : "s"}`;
  return grid && settled ? `${count} · ${grid.cols}×${grid.rows}` : `${count} · measuring…`;
}

/**
 * The input facts, as four rows: the queue's own state on the main row, and
 * the echo p50, echo max and oldest-wait each on a row of their own. One
 * number per row is what makes them diff-able between renders with the eye —
 * the joined detail line these replaced made the p50 move while the reader
 * was still parsing the previous sentence. `engaged` is null when there is
 * no queue at all (no attach yet); false is split by {@link reconnects},
 * because the queue's own stats cannot say WHY it is unengaged: within the
 * first attach the innocent reason is the pre-engage window (the server has
 * not answered yet, bytes possibly buffered), which reads "starting";
 * "no acks" is reserved for a queue that survived a reconnect and still
 * never engaged, i.e. one the server answered without `inputAcks`. The key
 * is an approximation (a no-acks answer on a never-reconnected attach also
 * reads "starting") and is accepted because the queue carries no
 * answered-without-acks fact of its own.
 */
export function inputWords(args: {
  hasQueue: boolean;
  stats: InputQueueStats;
  rtt: RttSamples;
  engaged: boolean | null;
  reconnects: number;
}): { main: string; echoP50: string | null; echoMax: string | null; oldest: string | null } {
  const empty = { main: "unknown", echoP50: null, echoMax: null, oldest: null };
  if (!args.hasQueue) return empty;
  if (args.engaged === false && args.reconnects === 0) {
    return { main: "starting", echoP50: null, echoMax: null, oldest: null };
  }
  const mainParts: string[] = [];
  if (args.stats.depth === 0) mainParts.push("idle");
  else {
    mainParts.push(`${args.stats.inFlight} in flight`);
    if (args.stats.backlog > 0) mainParts.push(`${args.stats.backlog} waiting`);
  }
  if (args.engaged === false) mainParts.push("no acks");
  // Narrowed in the condition itself so no `as number` is needed: the
  // samples are either both present or neither is.
  const echo =
    args.rtt.count > 0 && args.rtt.p50 !== null && args.rtt.max !== null
      ? { p50: formatMs(args.rtt.p50), max: formatMs(args.rtt.max) }
      : null;
  return {
    main: mainParts.join(" · "),
    echoP50: echo?.p50 ?? null,
    echoMax: echo?.max ?? null,
    oldest: args.stats.unackedOldestMs !== null ? `${formatMs(args.stats.unackedOldestMs)} unacked` : null,
  };
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
  // never disagree with the rest of the app about the state. A dead pane
  // shows the shared word alone ("ended", the terminated row's own word)
  // with the exit code beside it, because "exited" and "ended" naming one
  // state is one state with two vocabularies; a live pane keeps both, where
  // "alive" is a fact the state word does not carry.
  const pane = paneWord(subshell);
  const indicator = subshell ? INDICATOR_LABEL[subshellIndicator(subshell)] : null;
  const codeSuffix = subshell && subshell.exitCode !== null ? ` (code ${subshell.exitCode})` : "";
  const paneValue = (() => {
    if (!subshell) return pane;
    if (!subshell.alive) {
      return indicator === "exited" || indicator === "ended" ? `${indicator}${codeSuffix}` : `${pane} · ${indicator}`;
    }
    return `${pane} · ${indicator}`;
  })();
  const nodeValue =
    subshell?.nodeOffline === true ? `${nodeLabel ?? "unknown node"} · unreachable` : (nodeLabel ?? "unknown node");
  const input = inputWords({
    hasQueue: queue !== null,
    stats,
    rtt,
    engaged: queue ? queue.engaged : null,
    reconnects,
  });
  const stalled = queueBadgeView(stats).stalled;

  return (
    <div className="pointer-events-none w-max max-w-[16rem] rounded-md bg-terminal-strip/85 px-2 py-1.5 text-detail backdrop-blur-sm">
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <Row label="Socket" value={socketValue} />
        <Row label="Node" value={nodeValue} />
        <Row label="Pane" value={paneValue} />
        <Row label="Viewers" value={viewersWord(viewers, socket)} />
        <Row label="Output" value={outputAgeWord(subshell)} />
        <Row label="Input" value={input.main} warning={stalled} />
        {input.echoP50 !== null && <Row label="Echo p50" value={input.echoP50} />}
        {input.echoMax !== null && <Row label="Echo max" value={input.echoMax} />}
        {input.oldest !== null && <Row label="Oldest" value={input.oldest} warning={stalled} />}
      </div>
    </div>
  );
}
