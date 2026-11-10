import type { Node } from "@internal/node-admin";
import { parseStoredVirtualDisplayRequest } from "@internal/subshell-protocol";
import { useEffect, useMemo, useRef } from "react";
import {
  emptyNewSubshellForm,
  type NewSubshellFormValue,
  pickNodeDefault,
} from "@/components/subshell-picker/launch-form-rules";
import type { InstancePluginRow } from "@/hooks/use-instance-plugins";
import type { RecentPathsResponse } from "@/hooks/use-recent-paths";
import { isUntouchedForm, launchTemplateFromList } from "@/lib/launch-defaults";
import { wireToPresetBlocks } from "@/lib/prompt-stack";
import { buildAgentOptions, defaultAgentId, harnessFitsNode } from "@/lib/subshell-compat";
import type { PresetRow } from "@/types/preset";
import type { SubshellView } from "@/types/subshell";

/**
 * The node correction for a preset that names no machine: keep the machine the
 * picker would settle on, unless it cannot run the preset's agent - then blank
 * it so choosing a node that has the agent is the next act.
 *
 * The agent the preset named is the thing worth keeping, and `pickNodeDefault`
 * keeps the pick blank while several nodes are selectable (or fills the sole
 * one), so a fleet with one valid target still settles by itself. Two cases
 * are deliberately left to the harness gate's named correction: a server-side
 * refusal (not installed, broken, disabled), where no machine could rescue the
 * agent, and a pick the re-home would immediately restore, where the blank
 * would only churn the node and clear a directory the preset named. A preset
 * that names a machine is left alone - the ordinary re-home and harness rules
 * own that case.
 */
function nodeForPreset(
  preset: PresetRow,
  next: NewSubshellFormValue,
  nodes: Node[],
  plugins: readonly InstancePluginRow[],
): NewSubshellFormValue {
  if (preset.nodeId != null) return next;
  const settled = nodes.find((n) => n.id === pickNodeDefault(nodes, next.nodeId)) ?? null;
  const serverFit = buildAgentOptions(plugins, null).find((o) => o.value === preset.harnessId);
  if (settled === null || serverFit === undefined || serverFit.disabled) return next;
  if (harnessFitsNode(settled, preset.harnessId) === null) return next;
  // The re-home would put this node straight back, so blanking cannot stick.
  if (pickNodeDefault(nodes, "") === settled.id) return next;
  return { ...next, nodeId: "" };
}

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
  /** A caller selected the machine, so the last launch must not replace it. */
  skipPriorLaunch?: boolean;
  /** Readiness belongs to this exact node/provider pair, never a prior render. */
  displayCheck: { nodeId: string; provider?: string; reason?: string; unavailable: boolean };
}

/**
 * The launch form's defaults: the ONE effect that composes every automatic
 * correction, plus the explicit act that outranks it: `applyPreset` (choosing
 * a preset, which since spec 2026-09-29 carries the preset's own node,
 * directory, and prompt - and since 2026-09-30 RESETS the form first and
 * fills the agent too: a faithful copy, still editable everywhere). Split
 * out of `new-subshell-form.tsx` (2026-09-25 file-size split) with the
 * behavior and the ordering rules intact - read the effect's own comments for
 * why each gate waits on what it waits on.
 */
export interface LaunchFormActions {
  /** Choosing a preset: RESETS the form and fills what the preset names */
  applyPreset: (preset: PresetRow | null) => void;
}

export function useLaunchFormDefaults(args: LaunchFormDefaults): LaunchFormActions {
  const { value, onChange, nodes, nodesPending, plugins, presetRows, recent, subshells, subshellsPending, firstRun } =
    args;
  const { displayCheck, skipPriorLaunch = false } = args;
  const displayReviewNodeRef = useRef<string | null>(null);
  const agentDefaultBlockedRef = useRef(false);
  // A preset picked before the node list or plugin catalog answered: the
  // machine question `nodeForPreset` asks is re-run by the effect, once, the
  // moment the answer lands - and only while the form still holds the node
  // the pick settled on. A machine the person chose since belongs to the
  // explicit switch rule, whose clearing comes with an explanation.
  const presetNodeCheckRef = useRef<{ preset: PresetRow; nodeId: string } | null>(null);

  // The full default launch reads the newest prior subshell — data the ONE
  // live-fed list already holds, so no new request. ONE selector with the
  // agent tier (its harness hint in the effect below), so they can never
  // disagree about which row is "recent". Memoized on the list: a fresh
  // object per render would re-trigger the effect that depends on it.
  const recentTemplate = useMemo(() => launchTemplateFromList(subshells), [subshells]);
  // Apply the previous node and directory only once per fresh form.
  const priorLaunchAppliedRef = useRef(false);

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

  // ONE effect for all automatic corrections (prior-launch node+dir → node
  // re-home → working-dir pre-fill → agent default): composing the
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
    // rides the settled tier below, on this same pass. The
    // gate waits on the node list like everything else here: arming a node
    // the settled pick then re-homes away from is the ordering this effect's
    // comments exist to keep impossible.
    if (
      !priorLaunchAppliedRef.current &&
      recentTemplate !== null &&
      nodes !== null &&
      // First-run setup uses its own starting values.
      !firstRun &&
      !skipPriorLaunch &&
      isUntouchedForm(next, emptyNewSubshellForm())
    ) {
      priorLaunchAppliedRef.current = true;
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
    // The machine changed between renders (a user pick, or the re-home
    // above): drop the carried-over path and re-arm the seed, so the new
    // machine's own most-recent-else-home fills when its query answers. The
    // deferred correction below syncs `dirNodeRef` itself, so it never
    // reaches this block.
    if (next.nodeId !== dirNodeRef.current) {
      displayReviewNodeRef.current = next.virtualDisplay ? next.nodeId : null;
      next = { ...next, harnessResetReason: undefined, displayResetReason: undefined };
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
        if (fallback && next.workingDir === "") {
          next = { ...next, workingDir: fallback };
          // Strict Mode can replay this effect before the parent commits the
          // new value. Keep the seed armed until that value reaches the form,
          // or a replay with cached paths can overwrite it with a blank.
        } else {
          prefillDoneRef.current = true;
        }
      }
    }
    // A preset picked before the node list or the plugin catalog answered
    // could not ask its machine question at apply time; ask it now, so the
    // harness gate below never throws the preset's agent away for a default
    // machine the person never chose. One shot: once the answer has been
    // applied (or the preset or agent has moved on), the form is the
    // person's, and a later node pick keeps the clearing rule it documents.
    // `value.nodeId`, not `next.nodeId`, decides "never chose": the re-home
    // above may legally move a vanished default, but a node the person picked
    // since the preset was applied is theirs, and the switch rule owns it.
    const deferred = presetNodeCheckRef.current;
    if (deferred !== null && nodes !== null && plugins !== undefined) {
      presetNodeCheckRef.current = null;
      if (
        value.nodeId === deferred.nodeId &&
        next.presetId === deferred.preset.id &&
        next.harnessId === deferred.preset.harnessId
      ) {
        const corrected = nodeForPreset(deferred.preset, next, nodes, plugins);
        // The correction moves the machine AFTER the pair rule above has run,
        // so its bookkeeping has to follow: the next pass would otherwise read
        // the picker's default as the machine the held directory belongs to,
        // and clear a directory the preset named (or one seeded for the
        // default) that the person never touched.
        if (corrected.nodeId !== next.nodeId) dirNodeRef.current = corrected.nodeId;
        next = corrected;
      }
    }
    const heldNode = nodes?.find((n) => n.id === next.nodeId) ?? null;
    if (next.harnessId && heldNode && plugins !== undefined) {
      const option = buildAgentOptions(plugins, heldNode).find((o) => o.value === next.harnessId);
      if (!option || option.disabled) {
        // Replacing an agent also changes which program receives the prompt.
        // Leave that decision to the user instead of silently picking another.
        const name = plugins.find((p) => p.id === next.harnessId)?.name ?? "The selected agent";
        agentDefaultBlockedRef.current = true;
        next = {
          ...next,
          harnessId: "",
          presetId: null,
          harnessResetReason: `${name} can't run on ${heldNode.name}. Choose another agent.`,
        };
      }
    }
    if (!next.virtualDisplay) displayReviewNodeRef.current = null;
    const currentDisplayCheck = displayCheck.nodeId === next.nodeId && displayCheck.provider === next.displayProvider;
    if (displayReviewNodeRef.current === next.nodeId && currentDisplayCheck) {
      if (displayCheck.unavailable) {
        displayReviewNodeRef.current = null;
        next = {
          ...next,
          virtualDisplay: false,
          displayProvider: undefined,
          displaySize: undefined,
          displayResetReason: `Virtual display was turned off. ${displayCheck.reason}`,
        };
      } else if (!displayCheck.reason) {
        displayReviewNodeRef.current = null;
      }
    }
    const displayUnavailable = next.virtualDisplay
      ? currentDisplayCheck
        ? displayCheck.reason
        : "Checking virtual display requirements…"
      : undefined;
    if (next.displayUnavailable !== displayUnavailable) next = { ...next, displayUnavailable };

    // Default agent, when the user has not chosen one. Reads the same disabled
    // set the dropdown renders — computed against the row this pass holds, so
    // even a same-pass re-home cannot select an agent the server would refuse.
    // Only ever fills a blank; an unmade preset pick needs no default.
    //
    // The subshells list must have ANSWERED before the fill fires: the fill
    // happens once (blank-only), so filling while the list is in flight
    // silently loses the recent-wins tier for the whole dialog session
    // (cross-client review, 2026-09-13). Answered-with-empty is fine —
    // recent = null and the first-usable tier stands; an ERRORED query has
    // not answered, and the fill stays armed for a later success, the same
    // gate-the-answered-not-the-value rule as the pre-fill above.
    if (
      !agentDefaultBlockedRef.current &&
      next.harnessId === "" &&
      plugins !== undefined &&
      nodes !== null &&
      !subshellsPending &&
      subshells !== undefined
    ) {
      const heldNode = nodes.find((n) => n.id === next.nodeId) ?? null;
      const dflt = defaultAgentId(buildAgentOptions(plugins, heldNode), plugins, recentTemplate?.harnessId ?? null);
      if (dflt !== null) next = { ...next, harnessId: dflt };
      // Presets are copied only through an explicit selection. Reapplying
      // the last subshell's preset would undo Cancel's fresh-form reset.
    }
    // The one guard: a preset belongs to exactly one agent, and a launch
    // may only carry an ENABLED preset (spec 2026-10-24). (Agent changes
    // reset the preset at the control; this catches a row that vanished from
    // under a held pick, moved to another agent, or was switched off. The
    // recent-launch prefill rides this same check: the agent tier above may
    // have just armed the copy with a preset that the guard now drops, and
    // because the guard re-reads the full rows on EVERY pass, the prefill
    // degrades to no preset - the agent, node and directory the same row
    // copied stay, because only the link is what cannot launch.)
    if (next.presetId !== null && presetRows !== undefined) {
      const held = presetRows.find((p) => p.id === next.presetId);
      if (held === undefined || held.enabled === 0 || held.harnessId !== next.harnessId)
        next = { ...next, presetId: null };
    }
    if (next !== value) onChange(next);
    // nodesPending is a dep in its own right: a pending→ERROR transition
    // changes no data value, and without the flag the settling would never
    // re-run the effect that waits on it.
    // subshellsPending joins the deps the way nodesPending does: the
    // pending→ERROR transition changes no data value, and without the flag
    // this effect would never re-run to see that the gate stayed shut.
  }, [
    displayCheck,
    recent,
    nodes,
    nodesPending,
    plugins,
    presetRows,
    subshells,
    subshellsPending,
    recentTemplate,
    firstRun,
    skipPriorLaunch,
    value,
    onChange,
  ]);

  // Choosing a preset RESETS the form to a fresh one and then lays down
  // what the preset names - agent, machine, directory, prompt (operator
  // ruling 2026-09-30, second pass: "select a preset should reset the form
  // before copying"). The filled form is a faithful copy: a directory
  // typed before the pick belongs to the previous intent, and a preset
  // that names no directory leaves the field blank rather than quietly
  // keeping that older answer. What is filled stays editable; the preset
  // itself is never written back. Cancels a pending auto-default (the
  // copy's posture). The null arm - the membership guard's exit, dropping
  // a preset that no longer fits - clears only the link, never the fields
  // a preset filled: the person still sees what they are about to launch
  // with.
  function applyPreset(preset: PresetRow | null): void {
    priorLaunchAppliedRef.current = true;
    displayReviewNodeRef.current = null;
    if (preset === null) {
      onChange({ ...value, presetId: null });
      return;
    }
    let next: NewSubshellFormValue = { ...emptyNewSubshellForm(), presetId: preset.id, harnessId: preset.harnessId };
    // `== null` also covers a cached payload from before the hint column
    // existed: absent is "names no machine", exactly like null.
    if (preset.nodeId != null) next = { ...next, nodeId: preset.nodeId };
    // A preset names an agent; the machine is only a hint (spec 2026-09-29).
    // Blank the machine when the form's default cannot run that agent, rather
    // than let the harness gate throw the agent away - the one thing the
    // preset DID name (operator report 2026-11-09). Until the node list and
    // the plugin catalog answer there is nothing to ask, so the effect's
    // deferred check repeats this the moment they land.
    if (preset.nodeId == null) {
      if (nodes !== null && plugins !== undefined) next = nodeForPreset(preset, next, nodes, plugins);
      else presetNodeCheckRef.current = { preset, nodeId: next.nodeId };
    }
    if (preset.workingDir !== null) next = { ...next, workingDir: preset.workingDir };
    const display = preset.screenConfig ? parseStoredVirtualDisplayRequest(preset.screenConfig) : null;
    if (display)
      next = {
        ...next,
        virtualDisplay: true,
        displayProvider: display.provider,
        displaySize: { width: display.width, height: display.height },
      };
    const blocks = wireToPresetBlocks(preset.promptBlocks);
    if (blocks.length > 0) next = { ...next, promptBlocks: blocks };
    // The pair rule (2026-09-20): a directory is a claim about ONE machine,
    // so the node this write settled on owns the bookkeeping - and a preset
    // that named a dir outranks the per-node recents seed.
    dirNodeRef.current = next.nodeId;
    prefillDoneRef.current = next.workingDir !== "";
    onChange(next);
  }

  return { applyPreset };
}
