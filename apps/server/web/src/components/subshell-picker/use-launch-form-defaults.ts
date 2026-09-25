import type { Node } from "@internal/node-admin";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import {
  emptyNewSubshellForm,
  type NewSubshellFormValue,
  pickNodeDefault,
} from "@/components/subshell-picker/launch-form-rules";
import type { InstancePluginRow } from "@/hooks/use-instance-plugins";
import type { RecentPathsResponse } from "@/hooks/use-recent-paths";
import {
  isUntouchedForm,
  type LaunchTemplate,
  launchTemplateFromList,
  launchTemplateFromRow,
} from "@/lib/launch-defaults";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import { buildAgentOptions, defaultAgentId } from "@/lib/subshell-compat";
import type { PresetRow } from "@/types/preset";
import type { SubshellView } from "@/types/subshell";

/** What the defaults effect reads and corrects: everything it may write
 *  back through `onChange`, plus the settled-ness flags it waits on. The
 *  query-shaped fields carry their hook's answer verbatim — undefined until
 *  that query has answered, which is exactly what the gates read. */
export interface LaunchFormDefaults {
  /** The form's current value; the effect corrects it, never rewrites it in place */
  value: NewSubshellFormValue;
  /** The caller's setter — the effect's ONLY write path, as in the component */
  onChange: (value: NewSubshellFormValue) => void;
  /** The node list; null = not a usable payload yet (not settled, or malformed) */
  nodes: Node[] | null;
  /** Whether `useNodes` is still on its first answer (pending ≠ errored ≠ empty) */
  nodesPending: boolean;
  /** The plugin catalog; undefined = unanswered */
  plugins: readonly InstancePluginRow[] | undefined;
  /** The preset rows for the membership guard; undefined = unanswered */
  presetRows: PresetRow[] | undefined;
  /** The selected node's recents+home; undefined = unanswered */
  recent: RecentPathsResponse | undefined;
  /** The live subshells list the copy tier reads; undefined = unanswered */
  subshells: SubshellView[] | undefined;
  /** Whether `useSubshellsList` is still on its first answer */
  subshellsPending: boolean;
  /** The setup assistant's first launch: hides the Preset row, so the copy tier stands down */
  firstRun: boolean;
}

/**
 * The launch form's defaults: the ONE effect that composes every automatic
 * correction, and `applyCopy`, the "Copy settings from" picker's explicit
 * act. Split out of `new-subshell-form.tsx` (2026-09-25 file-size split)
 * with the behavior and the ordering rules intact — read the effect's own
 * comments for why each gate waits on what it waits on.
 */
export function useLaunchFormDefaults(args: LaunchFormDefaults): (subshellId: string) => void {
  const { value, onChange, nodes, nodesPending, plugins, presetRows, recent, subshells, subshellsPending, firstRun } =
    args;

  // The full default launch reads the newest prior subshell — data the ONE
  // live-fed list already holds, so no new request. ONE selector with the
  // agent tier (its harness hint in the effect below), so they can never
  // disagree about which row is "recent". Memoized on the list: a fresh
  // object per render would re-trigger the effect that depends on it.
  const recentTemplate = useMemo(() => launchTemplateFromList(subshells), [subshells]);
  // Armed once (like every pre-fill here) and consumed by the agent tier
  // below. Held in a ref, not state: it is a scheduled correction inside the
  // ONE effect, and a render that showed it would be a second UI for it.
  const pendingTemplateRef = useRef<LaunchTemplate | null>(null);

  const prefillDoneRef = useRef(false);
  // The node the CURRENT `workingDir` was chosen against. A directory is a
  // claim about one machine's filesystem, so when the pick moves — the
  // Machine select, or the effect's own re-home over a vanished row — the
  // held path is another machine's answer: cleared, and the per-machine
  // seed re-armed (operator report 2026-09-20: the stale path survived the
  // switch, the picker opened on it, and the person waited out a remote 404
  // before Start over was possible). Same-kind precedent: an Agent change
  // resets Preset at the control, because the value belongs to the other
  // pick. Re-filling needs no staleness gate: the recents query is keyed
  // per node, so between the switch and the new node's answer there is
  // simply no data to fill from — the machine just left cannot answer for
  // the machine arrived at.
  const dirNodeRef = useRef(value.nodeId);

  const queryClient = useQueryClient();

  // ONE effect for all automatic corrections (prior-launch node+dir → node
  // re-home → working-dir pre-fill → agent+preset default): composing the
  // final value once makes the old cross-effect clobbering impossible. Runs
  // only after the node list actually loads; while it loads the default
  // "local" stands (the server accepts it).
  //
  // The node pick resolves FIRST and the node-scoped defaults read the node
  // this pass HOLDS, never the render's selected node — which derives from
  // `value` and can be one pass stale: at mount for a viewer whose `local`
  // vanished, this same effect moves the pick to an agent, and defaults read
  // against the left-behind row (or null, which greys nothing) would park the
  // form on an agent that node cannot run and a directory it does not have.
  useEffect(() => {
    let next = value;
    // The full default launch (operator rule, 2026-09-25): the form's node
    // and working directory pre-fill from the newest prior subshell, once,
    // and only while the form still holds the untouched baseline. Everything
    // that makes a form touched — a Split `initialForm`, a caller seed,
    // pre-settle typing — disqualifies this tier, never the picker. The agent
    // and its preset ride the settled tier below, on this same pass. The
    // gate waits on the node list like everything else here: arming a node
    // the settled pick then re-homes away from is the ordering this effect's
    // comments exist to keep impossible.
    if (
      pendingTemplateRef.current === null &&
      recentTemplate !== null &&
      nodes !== null &&
      // First run asks nothing it cannot show: the row it would fill a preset
      // into is hidden there, and an applied-but-invisible preset is a worse
      // launch than a cold one.
      !firstRun &&
      isUntouchedForm(next, emptyNewSubshellForm())
    ) {
      pendingTemplateRef.current = recentTemplate;
      const t = recentTemplate;
      next = { ...next, nodeId: t.nodeId, workingDir: t.workingDir };
      // The copied pair belongs together: `dirNodeRef` records the machine
      // this directory is a claim about (so a real later switch still clears
      // it), and the recents seed stands aside — a copied directory outranks
      // the generic most-recent path. With no directory to copy, the seed
      // stays armed for whatever node the pick ends on.
      dirNodeRef.current = t.nodeId;
      prefillDoneRef.current = t.workingDir !== "";
    }
    if (nodes) {
      // Re-home the pick when what it pointed at vanished (e.g. an admin
      // turned off local launching).
      const pick = pickNodeDefault(nodes, next.nodeId);
      if (pick !== next.nodeId) next = { ...next, nodeId: pick };
    }
    // True while THIS pass moved the pick: the node-scoped `recent` query is
    // still the previous node's, so the directory default waits for the pass
    // that holds the final node (its query re-keys, lands, and fires here).
    const reHomed = next.nodeId !== value.nodeId;
    // The machine changed between renders (user pick, or the re-home just
    // above): drop the carried-over path and re-arm the seed, so the new
    // machine's own most-recent-else-home fills when its query answers.
    if (next.nodeId !== dirNodeRef.current) {
      dirNodeRef.current = next.nodeId;
      if (next.workingDir !== "") next = { ...next, workingDir: "" };
      prefillDoneRef.current = false;
    }
    // `!nodesPending` is the other half of "the pick is SETTLED". Arming is
    // one-way, and the recents query can answer while the node list is still
    // in flight (review round 2): arming then fills the mount default's scope
    // and a later arrival that re-homes the pick cannot correct it. Once the
    // node query has SETTLED the risk is gone even if its payload was
    // unusable — an unusable list can never move the pick (the block above
    // requires a real array), so gating on `nodes !== null` instead would
    // strand the pre-fill on a degraded registry for no safety gained.
    // The list gate is the seed yielding to the copy, not a second ordering:
    // `/recent` can answer BEFORE the subshells list on a cold load (the live
    // feed has not warmed the cache yet), and a seed that filled the field
    // there would make the form touched and disqualify the auto tier for the
    // whole session — "sometimes silently doesn't open on your last launch".
    // Same gate-the-answered-not-the-value rule as the agent tier: an ERRORED
    // list has not answered, so the seed stays armed rather than guessing the
    // list is empty.
    if (!prefillDoneRef.current && !reHomed && !nodesPending && !subshellsPending && subshells !== undefined) {
      // Most recent path, else the node's home. A fresh instance has no
      // recents at all, and an empty absolute-path box is the highest-friction
      // field in the product at the moment the user knows least about it.
      // Gate on the query having ANSWERED, not on a value being present:
      // keying off a path alone left the flag unset forever on a node with no
      // recents, so a later unrelated render could still fire the pre-fill.
      // (An errored query has not answered — the flag stays unarmed and a
      // later retry of the query can still pre-fill, which is the point.)
      const fallback = recent?.paths[0]?.path ?? recent?.home ?? "";
      if (recent !== undefined) {
        prefillDoneRef.current = true;
        if (fallback && next.workingDir === "") next = { ...next, workingDir: fallback };
      }
    }
    // Default agent, when the user has not chosen one. Reads the same disabled
    // set the dropdown renders — computed against the row this pass holds, so
    // even a same-pass re-home cannot select an agent the server would refuse.
    // Only ever fills a blank; the "None" preset state needs no default.
    //
    // The subshells list must have ANSWERED before the fill fires: the fill
    // happens once (blank-only), so filling while the list is in flight
    // silently loses the recent-wins tier for the whole dialog session
    // (cross-client review, 2026-09-13). Answered-with-empty is fine —
    // recent = null and the first-usable tier stands; an ERRORED query has
    // not answered, and the fill stays armed for a later success, the same
    // gate-the-answered-not-the-value rule as the pre-fill above.
    if (
      next.harnessId === "" &&
      plugins !== undefined &&
      nodes !== null &&
      !subshellsPending &&
      subshells !== undefined
    ) {
      const heldNode = nodes.find((n) => n.id === next.nodeId) ?? null;
      const dflt = defaultAgentId(buildAgentOptions(plugins, heldNode), plugins, recentTemplate?.harnessId ?? null);
      if (dflt !== null) next = { ...next, harnessId: dflt };
      // Consume the armed template either way — one-shot like the tier it
      // rides beside. Its preset follows only when ITS agent survived the
      // usability check; a prior launch under an agent this node cannot run
      // keeps the agent fallback and loses the preset, which is the honest
      // pair. (The membership guard below re-checks every pass regardless.)
      const t = pendingTemplateRef.current;
      if (t !== null) {
        pendingTemplateRef.current = null;
        if (dflt !== null && dflt === t.harnessId && t.presetId !== null) {
          next = { ...next, presetId: t.presetId };
        }
      }
    }
    // The one guard: a preset belongs to exactly one agent. (Agent changes
    // reset the preset at the control; this catches a row that vanished from
    // under a held pick.)
    if (next.presetId !== null && presetRows !== undefined) {
      const held = presetRows.find((p) => p.id === next.presetId);
      if (held === undefined || held.harnessId !== next.harnessId) next = { ...next, presetId: null };
    }
    if (next !== value) onChange(next);
    // nodesPending is a dep in its own right: a pending→ERROR transition
    // changes no data value, and without the flag the settling would never
    // re-run the effect that waits on it.
    // subshellsPending joins the deps the way nodesPending does: the
    // pending→ERROR transition changes no data value, and without the flag
    // this effect would never re-run to see that the gate stayed shut.
  }, [
    recent,
    nodes,
    nodesPending,
    plugins,
    presetRows,
    subshells,
    subshellsPending,
    recentTemplate,
    firstRun,
    value,
    onChange,
  ]);

  // The picker's explicit act, unlike the auto tier: it applies over any
  // edits, and it cancels a pending auto-default. The pair rides the
  // effect's existing corrections (re-home, preset guard) exactly as a Split
  // `initialForm` does. The row itself stays unselected — the copy is an
  // action, not a held value the (re-pickable) fields would then contradict.
  function applyCopy(subshellId: string): void {
    const row = Array.isArray(subshells) ? subshells.find((s) => s.id === subshellId) : undefined;
    if (row === undefined) {
      // The row died (deleted, or revoked from view) between the option
      // rendering and the click. Nothing to copy, and the option is now a
      // lie: re-ask the list so it disappears, rather than letting the press
      // do nothing twice.
      void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
      return;
    }
    const t = launchTemplateFromRow(row);
    pendingTemplateRef.current = null;
    // Same copied-pair posture as the auto tier: the directory belongs to the
    // node it was copied with, and the recents seed stands aside for it.
    dirNodeRef.current = t.nodeId;
    prefillDoneRef.current = t.workingDir !== "";
    onChange({ harnessId: t.harnessId, presetId: t.presetId, nodeId: t.nodeId, workingDir: t.workingDir });
  }

  return applyCopy;
}
