import { cn } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { Fragment } from "react";
import { TooltipLabelledLines } from "@/components/sidebar/TooltipLabelledLines";
import { SubshellActionsMenu } from "@/components/subshell-actions-menu";
import { BELL_TONE, bellAnnouncement, DOT_CLASS, showsBell } from "@/components/subshell-dot";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { encodeSubshellDrag } from "@/lib/subshell-dnd";
import { INDICATOR_LABEL, sortByStatus, subshellIndicator, subshellStatusRank } from "@/lib/subshell-indicator";
import type { SubshellNodeGroup } from "@/lib/subshell-node-groups";
import { subshellRowTooltip } from "@/lib/subshell-row-tooltip";
import type { SubshellView } from "@/types/subshell";

/**
 * The rail's cell view: the dot's state language drawn at grid size.
 *
 * The design rule for this whole file is ONE state language, never a second
 * one: every fill comes from the dot's `DOT_CLASS` table, every bell from
 * `BELL_TONE`, every "is this a bell at all" from `showsBell`. A cell is what
 * a dot looks like when the rail trades text for density — a new SHAPE, not
 * new meaning. The label the row truncates is never lost: the cell keeps the
 * row's full tooltip, so name/machine/agent/status/path all reveal on hover
 * and focus exactly as they do on a row.
 */

/**
 * The cell's glyph: the subshell NAME's first letter, uppercased. Every rail
 * grid supplies it, grouped and flat alike (2026-09-25).
 *
 * The machine is NOT in the letter — it reads from the plate tint and from
 * the tooltip's `Node:` line (an earlier shape keyed letters to machines and
 * grew them to two on collision; the operator replaced it with the single
 * pane letter once the plate carried the machine). Which means many cells
 * share a glyph — the grid is a density view and the tooltip is the truth,
 * so the letter is a hint, never a key. Pinned by test so nobody "fixes"
 * the collisions back into per-grid state.
 */
export function paneInitial(name: string): string {
  return name.slice(0, 1).toUpperCase();
}

/** How many machine tints the palette has — see `--node-tint-*` in styles.css. */
const TINT_COUNT = 8;

/**
 * The machine-plate bucket for a node NAME: FNV-1a folded into eight slots.
 *
 * Deterministic and seedless (no `Math.random`, nothing server-side): the
 * same name paints the same tint on every device, and the only input is the
 * NAME — so an admin's rename moves a machine's colour when the new name
 * hashes elsewhere, which is the behaviour the operator asked for (the tint
 * clusters the grid visually, it identifies nothing; two machines may share
 * a bucket and the tooltip's `Node:` line stays the truth).
 */
export function nodeTintBucket(nodeName: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < nodeName.length; i++) {
    h ^= nodeName.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // `^` yields a SIGNED int32, so a fold with the top bit set would mod into
  // a negative bucket (caught by the range test) — the unsigned shift right
  // here is the load-bearing one, not tidying.
  return ((h ^ (h >>> 16)) >>> 0) % TINT_COUNT;
}

/** The plate class per bucket, in `nodeTintBucket` order (0-based). */
const NODE_TINT_CLASS = [
  "bg-node-tint-1",
  "bg-node-tint-2",
  "bg-node-tint-3",
  "bg-node-tint-4",
  "bg-node-tint-5",
  "bg-node-tint-6",
  "bg-node-tint-7",
  "bg-node-tint-8",
] as const;

/**
 * The flat grid's cell set: the rows grouped mode would render with EVERY
 * group open (a collapsed group is grouped mode's privilege; a headerless
 * grid has nothing to collapse — the SET is the pinned parity, not the
 * order), sorted by machine cluster — clusters ranked by their most urgent
 * member, cells within a cluster sorted by the shared status band.
 *
 * The three arguments are the three things grouped mode draws in "cells":
 * each machine group's CAPPED rows, the comms section's rows, and the
 * Needs Attention spotlight. Deduped by id because the spotlight lists rows
 * that mostly also sit in their groups — a cell must never appear twice.
 *
 * The parity it enforces: a row capped out of its group is invisible to the
 * grid UNLESS the spotlight carries it — because in grouped mode that is
 * exactly when it is visible.
 *
 * The ORDER is clusters, not one flat band (operator ask on the plate
 * screenshot: machines should read "grouped button"-style): cells sharing
 * `keyOf` (the rail passes the resolved machine label) sit CONTIGUOUS, the
 * clusters rank by their liveliest member — the same MINIMUM-rank rule
 * `groupSubshellsByNode` uses, though over the rows THIS view can see:
 * grouped headers rank over their full pre-cap rows and never rank comms
 * panes into a machine, so a cluster's lead here can differ from a
 * header's rank there, accepted (the cluster order is the scan hint, the
 * tooltip is the truth) — and members sort by the shared band WITHIN the
 * cluster.
 */
export function flatCellRows(
  groups: readonly SubshellNodeGroup[],
  comms: readonly SubshellView[],
  spotlight: readonly SubshellView[],
  keyOf: (sub: SubshellView) => string,
): SubshellView[] {
  const byId = new Map<string, SubshellView>();
  for (const group of groups) for (const sub of group.subshells) byId.set(sub.id, sub);
  for (const sub of comms) byId.set(sub.id, sub);
  for (const sub of spotlight) byId.set(sub.id, sub);
  // Bucket by machine key, insertion-ordered; re-bucketing here (rather than
  // in the caller's grouping) is what lets the uncapped spotlight rows join
  // their machine's cluster.
  const clusters = new Map<string, SubshellView[]>();
  for (const sub of byId.values()) {
    const key = keyOf(sub);
    const bucket = clusters.get(key);
    if (bucket) bucket.push(sub);
    else clusters.set(key, [sub]);
  }
  const ranked = [...clusters.values()]
    .map((members) => ({
      members,
      // The same rule the grouped headers rank by (see `groupSubshellsByNode`):
      // a machine with something waiting for you leads, whatever the earlier
      // one-time sort thought. `members` is non-empty by construction.
      rank: Math.min(...members.map(subshellStatusRank)),
    }))
    // Stable, so equal-rank clusters keep discovery order.
    .sort((a, b) => a.rank - b.rank);
  return ranked.flatMap(({ members }) => sortByStatus(members));
}

/**
 * The LETTER is white on every state, one operator ruling dated 2026-09-27.
 *
 * This REPLACES the 2026-09-25 apparatus it supersedes: the muted plate and
 * the green letter-chip existed only to rescue a BLACK knockout letter (a
 * dark letter on a fading fill vanished in the blink's off phase, dark on
 * dark, operator ask then). A WHITE letter needs neither rescue: it reads on
 * the dark rail in every phase, so the blinking square carries NO background
 * at all and the pulse lives on the BORDER ring — the state's green survives
 * as an edge, never a field (an off-phase green FIELD was the "second idle"
 * the old note refused, and the dimmed-green field in it is exactly what the
 * operator rejected on 2026-09-27). The per-state INITIAL_TONE table died
 * with the knockout it existed to place: the letter is `text-foreground`
 * everywhere, and the square's fill/border keeps naming the state.
 */
const INITIAL_CLASS = "text-foreground";

/** The blink rides the BORDER ring: derived from `DOT_CLASS.active`, never
 * restated (the 2026-09-25 review's principle outliving the chip it fed) —
 * the fill tone swapped from `bg-` to its `border-` sibling, the blink class
 * carried through, so a tone change to the table moves the ring with it.
 *
 * Two things this swap makes non-obvious, both pinned at the render site:
 * the produced class is a border COLOR utility, so the span carries an
 * explicit `border` width or Tailwind v4's preflight (`border: 0 solid`)
 * leaves a zero-width, invisible ring; and the `border-*` string is assembled
 * at RUNTIME, so the scanner never sees it in source — `styles.css` carries an
 * `@source inline("border-success")` witness, NOT the test's literal, because
 * a class that only exists because a test asserts it is not in the shipped
 * page's dependency graph. */
const ACTIVE_RING = DOT_CLASS.active
  .split(" ")
  .map((cls) => (cls.startsWith("bg-") ? cls.replace(/^bg-/, "border-") : cls))
  .join(" ");

/** The resolved labels for one cell — the same four the row's tooltip takes. */
export interface SubshellCellLabels {
  /** The machine's label: a group header's, or the resolved name in flat mode */
  nodeLabel: string;
  /** The harness's display name, falling back to its id */
  agentLabel: string;
  /** The preset's name when the launch has one; undefined omits the line */
  presetLabel?: string;
  /** The pane's initial letter. Every rail grid supplies one (2026-09-25:
   * grouped cells without letters read as blank colour squares); optional
   * because a cell is still a faithful square with no letter at all */
  initial?: string;
}

/**
 * One status cell: a 24px square that is simultaneously the nav Link, the
 * drag source, the tooltip host and the right-click menu subject — the row's
 * gesture set whole on a smaller target. Same composition as
 * `SubshellRecentRow` (Base UI's `render` merging the trigger onto the Link),
 * same tooltip string.
 *
 * The square itself carries the state: `DOT_CLASS` fills for everything
 * quiet, the working state NO fill but a blinking border ring (operator
 * ruling 2026-09-27), and a bell (`showsBell`) REPLACES the fill, the dot's
 * posture — the glyph names "unseen push", the tone keeps the state.
 * The open subshell wears a `ring-1 ring-foreground/70` so one cell still
 * says "you are here" (hover raises the same ink to full brightness). The
 * accessible name is "name: status word", and for a bell "name: unseen
 * notification (status word)" — the shared {@link bellAnnouncement} — since
 * a square of colour has nothing to read out and its glyph is aria-hidden.
 *
 * `data-status`/`data-alive` are the DOT's e2e hooks and deliberately NOT
 * copied here: the cell is a derivative view, and liveness assertions belong
 * on the renderer that predates them.
 */
export function SubshellCell({
  subshell,
  active,
  labels,
}: {
  subshell: SubshellView;
  /** The subshell this page is showing — the cell's "you are here". */
  active: boolean;
  labels: SubshellCellLabels;
}) {
  const indicator = subshellIndicator(subshell);
  const bell = showsBell(subshell);
  // The ACTIVE square is the one with no fill at all (operator ruling
  // 2026-09-27): a neutral bordered frame, a white letter that never fades,
  // and the pulse on a BORDER ring layer — `subshell-dot-blink` animates the
  // ring's opacity to 0 (steps(1), styles.css), so the state's green arrives
  // and leaves as an edge, never as a dimmed field. Every other state keeps
  // its fill on the anchor exactly as before — `terminated`'s hollow reading
  // especially: nothing goes behind it.
  const blinking = !bell && indicator === "active";
  const cell = (
    <TooltipProvider delay={300}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/subshells/$id"
              params={{ id: subshell.id }}
              draggable
              onDragStart={(e) => encodeSubshellDrag(e.dataTransfer, subshell.id)}
              aria-label={`${subshell.name}: ${bell ? bellAnnouncement(INDICATOR_LABEL[indicator]) : INDICATOR_LABEL[indicator]}`}
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-md font-strong text-label transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                blinking || bell
                  ? // The blinking square and a bell share ONE neutral posture:
                    // a bordered frame carrying no state FILL — the blink
                    // pulses its own ring layer, the bell tones its glyph
                    // (exactly as on the dot, whose bell path carries no
                    // DOT_CLASS fill either; operator ruling 2026-09-27
                    // widened it to the blink: no background on the field).
                    "relative border border-border bg-transparent"
                  : DOT_CLASS[indicator],
                // Hover says "this one" with the theme INK at FULL
                // brightness; selection is the same ink DIMMED to /70 (live
                // review: the full frost was the loudest thing on the rail),
                // so a hovered selected cell just sharpens. Focus stays the
                // RING token: orchid at width 2, a reading the other two
                // cannot impersonate.
                "hover:ring-1 hover:ring-foreground",
                active && "ring-1 ring-foreground/70",
              )}
            />
          }
        >
          {bell ? (
            <Bell size={14} aria-hidden={true} className={BELL_TONE[indicator]} />
          ) : blinking ? (
            <>
              {/* Positioned siblings paint above in-flow content, so the
                  white initial is `relative` to rejoin the stacking tail:
                  it stays put in EVERY blink phase while only the ring
                  fades (operator ruling 2026-09-27: no background at all,
                  the letter remains). */}
              <span aria-hidden={true} className={cn("absolute inset-0 rounded-md border", ACTIVE_RING)} />
              {labels.initial ? <span className={cn("relative", INITIAL_CLASS)}>{labels.initial}</span> : null}
            </>
          ) : labels.initial ? (
            <span className={INITIAL_CLASS}>{labels.initial}</span>
          ) : null}
        </TooltipTrigger>
        {/* `bottom`, not the row's `right`: the rail hugs the screen's left
            edge but the row's popup has the wide page to grow into, while a
            cell's right-side popup lands over the very cells you were
            comparing (operator: hard to mouse between). Labels bolded via
            the shared renderer the rows use too. */}
        <TooltipContent side="bottom" className="whitespace-pre-line break-words">
          <TooltipLabelledLines
            text={subshellRowTooltip(subshell, labels.nodeLabel, labels.agentLabel, labels.presetLabel)}
          />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
  return <SubshellActionsMenu subshell={subshell}>{cell}</SubshellActionsMenu>;
}

/**
 * A wrapping grid of cells. `gap-1.5` (6px) is the ONE cell-to-cell rhythm
 * both cell modes keep — grouped's spacing, matched in flat by the
 * operator's explicit call ("we should have the same gap as we do in the
 * grouped view"). The inset differs by mode on purpose: the plain
 * grid's `px-3` lands its first cell on a group header's label line, and
 * the tinted grid's `px-2` lands ITS first cell on that same line — a
 * plate's own 4px gutter is the extra 4px (two insets, one visual line;
 * operator live review).
 *
 * `labelsFor` is a resolver rather than a uniform label because the flat grid
 * is exactly the case where a label varies per cell (each cell's tooltip
 * names its own machine) while a grouped grid passes every cell its header's.
 * One prop, both modes, no mode flag on the grid.
 *
 * `tintOf` — flat mode only — plates cells like a button group: each run of
 * CONSECUTIVE equal buckets gets ONE `p-1 rounded-lg inline-flex gap-1.5`
 * container of `--node-tint-N`, because the machine cluster (not the cell) is
 * the visual unit. The 4px gutter is not taste: the selection ring paints
 * OUTSIDE the cell box, and at 2px it touched the plate edge — `p-1` clears
 * `ring-1` on every side (operator ask on the cluster screenshot).
 * `flatCellRows` guarantees runs are per-machine by making clusters
 * contiguous; the grid grouping is by tint, so two machines whose buckets
 * collide render as one continuous plate — the same hint-not-key reading
 * `nodeTintBucket` already documents, with the tooltip as the truth.
 * The inner gap is `gap-1.5` — the SAME 6px the grouped view's cells sit at,
 * by the operator's explicit choice ("we should have the same gap as we do in
 * the grouped view"); the outer grid keeps it too, and cells across a plate
 * boundary already land 14px apart (6 + the two 4px gutters), so plates
 * separate without a bigger number. Full `rounded-md` on each cell keeps
 * every state whole at the plate edge. The plate is a layout `div`,
 * deliberately NOT `aria-hidden`: an aria-hidden ancestor of a focusable link
 * drops the link from the accessibility tree, and a bare div adds nothing to
 * announce anyway. Grouped grids omit the prop and render unwrapped, exactly
 * as headers already did the naming.
 */
export function SubshellCellGrid({
  rows,
  activeId,
  labelsFor,
  tintOf,
}: {
  rows: readonly SubshellView[];
  /** The id of the subshell the current page shows, or null */
  activeId: string | null;
  labelsFor: (sub: SubshellView) => SubshellCellLabels;
  /** Machine-tint bucket per row; present = flat mode's plate PER RUN */
  tintOf?: (sub: SubshellView) => number;
}) {
  /** The modulo re-pins the range at the render boundary even though
   * `nodeTintBucket` is already 0..7 — a plate must never index off the
   * palette array into `undefined` and render an unstyled square. */
  const bucketOf = (sub: SubshellView) => {
    const raw = (tintOf?.(sub) ?? 0) % TINT_COUNT;
    return (raw + TINT_COUNT) % TINT_COUNT;
  };
  const renderCell = (sub: SubshellView) => (
    <SubshellCell subshell={sub} active={activeId !== null && activeId === sub.id} labels={labelsFor(sub)} />
  );
  if (tintOf === undefined) {
    return (
      <div className="flex flex-wrap gap-1.5 px-3 py-1">
        {rows.map((sub) => (
          <Fragment key={sub.id}>{renderCell(sub)}</Fragment>
        ))}
      </div>
    );
  }
  // Runs of consecutive equal buckets share one plate. `flatCellRows` makes
  // a machine's rows contiguous, so a run IS a machine cluster (or two
  // same-bucket clusters touching, which reads as one — documented).
  const runs: { bucket: number; rows: SubshellView[] }[] = [];
  for (const sub of rows) {
    const bucket = bucketOf(sub);
    const last = runs[runs.length - 1];
    if (last && last.bucket === bucket) last.rows.push(sub);
    else runs.push({ bucket, rows: [sub] });
  }
  return (
    <div className="flex flex-wrap gap-1.5 px-2 py-1">
      {runs.map((run) => (
        <div
          key={run.rows[0]?.id}
          className={cn("inline-flex items-center gap-1.5 rounded-lg p-1", NODE_TINT_CLASS[run.bucket])}
        >
          {run.rows.map((sub) => (
            <Fragment key={sub.id}>{renderCell(sub)}</Fragment>
          ))}
        </div>
      ))}
    </div>
  );
}
