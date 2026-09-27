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
import { requestWorkspacePaneFocus } from "@/lib/workspace-focus";
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
 * The flat grid's cell set, ordered in FOUR bands (operator order
 * 2026-09-26): the Needs Attention spotlight, then machine clusters that hold a
 * SELECTED pane, then every other machine cluster, then cross-agent comms.
 *
 * The four arguments are the pieces grouped mode draws: each machine group's
 * CAPPED rows, the comms section's rows, the Needs Attention spotlight, and the
 * set of ids the current workspace has open (its panes — the ring the cells
 * wear). The machine clusters come from the GROUPS ONLY: comms are partitioned
 * out of them upstream and get their own band, and the spotlight is a SIBLING,
 * never an extraction — a notification row stays inside its machine cluster
 * here too (operator ruling 2026-09-26: bands appear AND keep their cluster),
 * so a spotlight row may legitimately show twice, once in the top band and once
 * in its machine's run. The parity that still holds: a row capped out of its
 * group is invisible to the grid UNLESS the spotlight carries it — in which case
 * it appears in the top band, exactly as grouped mode surfaces it.
 *
 * Within the cluster bands, one machine's cells sit CONTIGUOUS (the group IS the
 * cluster — the caller's `groupSubshellsByNode` already keyed them by machine,
 * so there is no re-bucketing here), the clusters rank by their liveliest member
 * — the same MINIMUM-rank rule `groupSubshellsByNode` uses, over the rows THIS
 * view can see — and members sort by the shared status band WITHIN a cluster.
 * Selection outranks urgency across clusters; urgency still orders WITHIN each
 * band.
 */
export function flatCellRows(
  groups: readonly SubshellNodeGroup[],
  comms: readonly SubshellView[],
  spotlight: readonly SubshellView[],
  selectedIds: ReadonlySet<string>,
): SubshellView[] {
  // Band 1: notifications lead the grid. Sorted by the shared band so the most
  // urgent unseen sits top-left.
  const notifications = sortByStatus(spotlight);
  // Bands 2 + 3: machine clusters, from the groups only. A cluster holding a
  // selected pane leads; inside each half the grouped-mode urgency rank still
  // orders (stable, so equal ranks keep discovery order).
  const clusters = groups.map((group) => ({
    members: group.subshells,
    selected: group.subshells.some((sub) => selectedIds.has(sub.id)),
    rank: group.subshells.length ? Math.min(...group.subshells.map(subshellStatusRank)) : Number.POSITIVE_INFINITY,
  }));
  const machines = clusters
    .sort((a, b) => Number(b.selected) - Number(a.selected) || a.rank - b.rank)
    .flatMap((cluster) => sortByStatus(cluster.members));
  // Band 4: cross-agent comms last.
  return [...notifications, ...machines, ...sortByStatus(comms)];
}

/**
 * The LETTER is white (`text-foreground`) by default, an operator ruling dated
 * 2026-09-27. The 2026-09-25 apparatus it supersedes — a muted plate + green
 * letter-chip that existed only to rescue a BLACK knockout letter — is gone.
 * Solid light fills defeat white below AA, so they take a narrow dark knockout
 * (see {@link DARK_KNOCKOUT}); idle's `success/50` keeps white (4.34:1) and
 * `terminated` is hollow (white on the dark rail). The letter is a hint, not a
 * key — the fill/nodes names the state, the tooltip is the truth.
 */
const INITIAL_CLASS = "text-foreground";

/** Solid fills where white drops below AA (design-tokens contrast math):
 * `waiting` on `--warning` (1.34:1) and `node-offline` on `--destructive`
 * (2.77:1). `active` was the third entry — the blink's full-`--success` tile
 * took a dark initial (image #9 ruling, 2026-09-27, same day) — but the
 * operator retired that pairing: the working cell now shows NO full-green
 * beat at all (see the render site), so there is no bright field to knock
 * out. White on the remaining states stands: idle's `success/50` clears
 * 4.34:1, and the working letter sits on the rail or the half fill, white
 * both beats. */
const DARK_KNOCKOUT: Partial<Record<SubshellIndicator, true>> = {
  waiting: true,
  "node-offline": true,
};

/** The initial's color for one state: dark only on a solid fill that eats
 * white, white on the no-fill and semitransparent states. */
const initialClass = (indicator: SubshellIndicator): string =>
  DARK_KNOCKOUT[indicator] ? "text-background" : INITIAL_CLASS;

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
 * The square itself carries the state: `DOT_CLASS` fills for everything quiet,
 * the working state pulses a half-green fill behind a constant white initial
 * (see {@link blinking} below), and a
 * bell (`showsBell`) REPLACES the fill, the dot's posture — the glyph names
 * "unseen push", the tone keeps the state. Every open pane's cell (the
 * workspace's SET, focused included) wears ONE soft `ring-1 ring-foreground/70`
 * (operator ruling 2026-09-27, same day as the two-width version it replaces:
 * the `ring-2` focus ring read too heavy at cell size, and at one width the
 * two levels stop being tellable apart, so there is one level). The accessible name is "name: status
 * word", and for a bell "name: unseen notification (status word)" — the shared
 * {@link bellAnnouncement} — since a square of colour has nothing to read out
 * and its glyph is aria-hidden.
 *
 * `data-status`/`data-alive` are the DOT's e2e hooks and deliberately NOT
 * copied here: the cell is a derivative view, and liveness assertions belong
 * on the renderer that predates them.
 */
export function SubshellCell({
  subshell,
  selected,
  focused,
  focusOnOpen,
  labels,
}: {
  subshell: SubshellView;
  /** Open in the current workspace (or the viewed page) — marks the SET. */
  selected: boolean;
  /** The pane the dock has focused. It rings like every other open cell; kept
   * because a focused pane must wear the ring even before the SET catches up. */
  focused: boolean;
  /**
   * The cell is a pane of the workspace on screen, so a click should FOCUS that
   * tab instead of navigating to `/subshells/:id` and leaving the workspace
   * (operator report 2026-09-27). Only true while a dock exists to act on it.
   */
  focusOnOpen?: boolean;
  labels: SubshellCellLabels;
}) {
  const indicator = subshellIndicator(subshell);
  const bell = showsBell(subshell);
  // The ACTIVE square pulses its FILL only: a `bg-success/50` tile blinking
  // over the bare rail (see the render site) behind a constant white initial.
  // It used to blink between two painted tiles — full green with a dark
  // knockout letter over the half-green one — so no beat ever lacked a box.
  // The operator retired the solid-green beat on 2026-09-27: transparent
  // background + white letter on that half, which also retires the dark
  // knockout (images #10/#11/#14 were symptoms of stranding a DARK letter on
  // an empty tile; a white one reads on the rail exactly as `terminated`'s
  // does — and an UN-RINGED working cell keeps a static `--border` frame so
  // even the empty half is a square, operator 2026-09-27 follow-up). Every
  // other state keeps its single static fill on the anchor
  // exactly as before — `terminated`'s hollow reading especially: nothing
  // behind it.
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
              // A workspace member clicked in the rail focuses its tab in place.
              // Only a plain left-click: ⌘/ctrl/shift-click keeps the browser's
              // open-in-new-tab. And navigation is suppressed only if the dock
              // actually activated the pane — a stale/unready pane falls through
              // to its normal link so the click is never a dead no-op.
              onClick={(e) => {
                if (
                  focusOnOpen &&
                  e.button === 0 &&
                  !e.metaKey &&
                  !e.ctrlKey &&
                  !e.shiftKey &&
                  requestWorkspacePaneFocus(subshell.id)
                ) {
                  e.preventDefault();
                }
              }}
              aria-label={`${subshell.name}: ${bell ? bellAnnouncement(INDICATOR_LABEL[indicator]) : INDICATOR_LABEL[indicator]}`}
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-md font-strong text-label transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                bell
                  ? // The viewed pane's bell tones its glyph on a neutral,
                    // bordered, STATIC field — the frame is the bell's posture,
                    // and there is nothing to blink behind it.
                    "relative border border-border bg-transparent"
                  : blinking
                    ? // No field of its own: the blinking half-green fill is a
                      // child layer, so the transparent half is genuinely empty
                      // rail with the white initial riding over it (the
                      // constant letter is a sibling above the fill). The
                      // square keeps a dark `--border` frame on that half —
                      // operator 2026-09-27: the letter floating with no box
                      // read broken, the frame is what stays — but only when
                      // the cell has NO ring: a selected/focused working cell
                      // already wears its frame in ink, and a border under the
                      // ring would just be a second line.
                      cn("relative bg-transparent", !selected && !focused && "border border-border")
                    : DOT_CLASS[indicator],
                // ONE ring for the whole open SET (operator 2026-09-27), SOFT so
                // the box matches the rows: `ring-1 ring-foreground/70` on every
                // open pane, focused or not. The focus bump to `ring-2` from the
                // same day read too heavy and was retired the same day. Hover
                // answers "which one am I on" at width 1 full ink; keyboard
                // focus stays the orchid RING token.
                "hover:ring-1 hover:ring-foreground",
                focused || selected ? "ring-1 ring-foreground/70" : undefined,
              )}
            />
          }
        >
          {bell ? (
            <Bell size={14} aria-hidden={true} className={BELL_TONE[indicator]} />
          ) : blinking ? (
            // The working cell pulses its FILL, never its letter: a half-green
            // tile (`bg-success/50`, the idle fill, driven by the plain
            // `subshell-dot-blink` opacity pulse so it switches on the same
            // beat as the dot) with a constant WHITE initial riding above it.
            // The transparent half is the bare rail with the white letter on it
            // — legible exactly as `terminated`'s hollow cell is, which is what
            // lets the solid-green + dark-knockout beat go away (operator
            // ruling 2026-09-27: that pairing read wrong; the letter is white,
            // the background transparent). The fill is aria-hidden layout, the
            // letter is the one the link reads out. Under reduced-motion the
            // class carries nothing: the cell rests as the half-green fill +
            // white initial, like idle, with the tooltip still saying working.
            <>
              <span
                aria-hidden={true}
                className={cn("subshell-dot-blink absolute inset-0 rounded-md", DOT_CLASS.idle)}
              />
              <span className={cn("relative", INITIAL_CLASS)}>{labels.initial}</span>
            </>
          ) : labels.initial ? (
            // Solid light fills defeat white (see `DARK_KNOCKOUT`); every
            // other state — idle's semitransparent green, terminated's hollow
            // — keeps the white letter.
            <span className={initialClass(indicator)}>{labels.initial}</span>
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
  selectedIds,
  focusedId,
  focusOnClick,
  labelsFor,
  tintOf,
}: {
  rows: readonly SubshellView[];
  /**
   * The SET of panes the current page holds open: the viewed `/subshells/:id`,
   * plus every pane of the `/workspaces/:id` you are standing in. Each wears the
   * soft selected ring.
   */
  selectedIds: ReadonlySet<string>;
  /**
   * The single pane the dock has focused (or the viewed page's id). Since the
   * one-ring ruling (operator 2026-09-27) it renders no differently from the
   * SET — it is carried so a just-focused pane rings even a beat before the
   * SET's query catches up.
   */
  focusedId: string | null;
  /**
   * True while standing in the workspace these cells belong to (a dock is up to
   * act): a selected cell's click focuses its pane rather than navigating out.
   */
  focusOnClick?: boolean;
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
    <SubshellCell
      subshell={sub}
      selected={selectedIds.has(sub.id)}
      focused={focusedId !== null && focusedId === sub.id}
      focusOnOpen={focusOnClick && selectedIds.has(sub.id)}
      labels={labelsFor(sub)}
    />
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
  // same-bucket clusters touching, which reads as one — documented). Keys are
  // per-OCCURRENCE, not per-id: a Needs-Attention row shows in BOTH its band and
  // its machine cluster, so the same subshell id recurs — even twice inside one
  // plate when a band run and the machine's run share a tint and touch. A bare
  // id key would hand React two siblings with one key (review MAJOR); an array
  // INDEX key trips `noArrayIndexKey` and isn't stable. So the first `x` keys as
  // `x`, the repeat as `x~2` — a stable, index-free identity for the render list.
  const seen = new Map<string, number>();
  const runs: { bucket: number; cells: { sub: SubshellView; key: string }[] }[] = [];
  for (const sub of rows) {
    const n = (seen.get(sub.id) ?? 0) + 1;
    seen.set(sub.id, n);
    const cell = { sub, key: n === 1 ? sub.id : `${sub.id}~${n}` };
    const bucket = bucketOf(sub);
    const last = runs[runs.length - 1];
    if (last && last.bucket === bucket) last.cells.push(cell);
    else runs.push({ bucket, cells: [cell] });
  }
  return (
    <div className="flex flex-wrap gap-1.5 px-2 py-1">
      {runs.map((run) => (
        <div
          key={run.cells[0]?.key}
          className={cn("inline-flex items-center gap-1.5 rounded-lg p-1", NODE_TINT_CLASS[run.bucket])}
        >
          {run.cells.map((c) => (
            <Fragment key={c.key}>{renderCell(c.sub)}</Fragment>
          ))}
        </div>
      ))}
    </div>
  );
}
