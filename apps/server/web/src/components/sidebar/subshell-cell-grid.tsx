import { cn } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { Fragment } from "react";
import { TooltipLabelledLines } from "@/components/sidebar/TooltipLabelledLines";
import { SubshellActionsMenu } from "@/components/subshell-actions-menu";
import { BELL_TONE, bellAnnouncement, DOT_CLASS, showsBell } from "@/components/subshell-dot";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { encodeSubshellDrag } from "@/lib/subshell-dnd";
import {
  INDICATOR_LABEL,
  type SubshellIndicator,
  sortByStatus,
  subshellIndicator,
  subshellStatusRank,
} from "@/lib/subshell-indicator";
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
 * Letter colour per state on a flat cell: solid fills carry the background
 * tone (green/amber/red under a dark letter would fight the fill), dim and
 * hollow ones carry the foreground (the letter IS the content there). Spelled
 * per indicator rather than by re-testing the fill class so a new state
 * shows up as a missing table key, not a silently wrong letter.
 */
const INITIAL_TONE: Record<SubshellIndicator, string> = {
  active: "text-background",
  waiting: "text-background",
  "node-offline": "text-background",
  idle: "text-foreground",
  exited: "text-foreground",
  terminated: "text-foreground",
};

/**
 * The LETTER CHIP under a blinking cell's glyph: the fill half of
 * `DOT_CLASS["active"]` without the blink (`active` is the only state that
 * blinks, so the table lookup would be one value). The chip rides ABOVE the
 * fading layer, so the letter's contrast pair — knockout on green — is the
 * same in the blink's on phase and its off phase; without it the
 * `text-background` letter sat directly on the muted plate and read as a
 * missing glyph (first operator ask on the live grid).
 *
 * It is GLYPH-SIZED on purpose (`px-0.5 leading-none`, applied at the span):
 * the first chip padded to the line box, and at that fullness the off phase
 * stayed a bright green pill in a dark rim — the pulse read as FROZEN, and a
 * selected blinking cell drifted toward `idle`'s look (operator screenshot
 * 2026-09-25). Shrunk to the glyph, the plate carries the pulse and the pill
 * covers well under half the square in the off phase. What must never move:
 * the chip going UNDER the fading layer (reintroduces the dark-on-dark
 * vanish), or the off-phase plate dimming toward success/50 (an off-phase
 * green field would be a second `idle` — one state, one language).
 */
// Derived from the table, never restated (2026-09-25 review): a tone change
// to `DOT_CLASS.active` moves the chip with the fill it sits on.
const ACTIVE_CHIP = DOT_CLASS.active
  .split(" ")
  .filter((cls) => !cls.includes("blink"))
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
 * The square itself carries the state: `DOT_CLASS` fills and the working
 * blink for everything quiet, and a bell (`showsBell`) REPLACES the fill, the
 * dot's posture — the glyph names "unseen push", the tone keeps the state.
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
  // The blink animates the element's opacity to 0 (steps(1), styles.css), so
  // the ACTIVE square alone gets layered: a persistent muted plate underneath
  // and the fill on a layer that fades — the cell pulses where the dot's 6px
  // circle simply blanks out for 800ms (operator ask: vanishing reads as
  // broken at 24px). Every other state keeps the fill on the anchor, exactly
  // as rendered before this branch existed — `terminated`'s hollow reading
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
                blinking
                  ? "relative"
                  : // A bell sits on a neutral bordered square: the square belongs
                    // to no state, the tone belongs to the glyph — exactly as on
                    // the dot, whose bell path carries no DOT_CLASS fill either.
                    bell
                    ? "border border-border bg-transparent"
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
                  initial (when the flat grid supplies one) gets `relative` to
                  rejoin the stacking tail and read ON the fill. */}
              <span aria-hidden={true} className="absolute inset-0 rounded-md bg-muted/50" />
              <span aria-hidden={true} className={cn("absolute inset-0 rounded-md", DOT_CLASS[indicator])} />
              {labels.initial ? (
                <span className={cn("relative rounded px-0.5 leading-none", ACTIVE_CHIP, INITIAL_TONE[indicator])}>
                  {labels.initial}
                </span>
              ) : null}
            </>
          ) : labels.initial ? (
            <span className={INITIAL_TONE[indicator]}>{labels.initial}</span>
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
