import { Link } from "@tanstack/react-router";
import type { JSX } from "react";
import { useEffect, useRef } from "react";
import { SearchableSelect } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WorkingDirField } from "@/components/working-dir-field";
import { useNodes } from "@/hooks/use-nodes";
import { useProfiles } from "@/hooks/use-profiles";
import { useRecentPaths } from "@/hooks/use-recent-paths";
import { NAME_MAX_DEFAULT } from "@/lib/name-limits";
import { isOfflineAgent } from "@/lib/node-label";
import { buildNodeOptions, buildProfileOptions, harnessFitsNode, type LaunchProfile } from "@/lib/subshell-compat";
import type { Node } from "@/types/node";

/** The fields needed to launch a new subshell. */
export interface NewSubshellFormValue {
  profileId: string;
  workingDir: string;
  name: string;
  /**
   * Launch node — defaults to "local" (the control-plane host). "" means no
   * valid choice is made yet (local vanished from the list with several other
   * nodes around), which blocks submit until the user picks one. A pinned
   * profile SUGGESTS its node (see `suggestDecision`) — a suggestion the
   * user can always override, and whose id now rides the wire when held.
   */
  nodeId: string;
  /**
   * True once the user picks a node through the picker; cleared on every
   * profile change. Distinguishes a user's own pick from a suggestion.
   */
  nodeExplicit?: boolean;
}

export function emptyNewSubshellForm(): NewSubshellFormValue {
  return { profileId: "", workingDir: "", name: "", nodeId: "local" };
}

/** True once the form has everything the create call requires. */
export function canSubmit(value: NewSubshellFormValue): boolean {
  return Boolean(value.profileId) && Boolean(value.workingDir.trim()) && Boolean(value.nodeId);
}

/**
 * Whether a node is pickable right now: an OFFLINE agent is shown disabled —
 * launching there 409s `NODE_OFFLINE`, and offering a target we know is down
 * would only invite a confusing failure. (The pick list can always be stale;
 * the 409 path covers the race.) Harness compatibility greys separately, via
 * `buildNodeOptions`. Mirrored in mobile `src/lib/node-anchor.ts`.
 */
function isSelectable(n: Node): boolean {
  return !isOfflineAgent(n);
}

/**
 * The node the picker should hold once the list has loaded: keep the current
 * pick while it stays selectable; else auto-pick the SOLE remaining selectable
 * option (typically an agent when Local is gone — not a decision worth
 * forcing); else "" — an explicit choice is due (submit stays blocked until
 * it happens).
 * Pure so the fallback matrix is testable without opening a dropdown.
 * Mirrored in mobile `src/lib/node-anchor.ts`.
 */
export function pickNodeDefault(nodes: Node[], current: string): string {
  if (nodes.some((n) => n.id === current && isSelectable(n))) return current;
  const selectable = nodes.filter(isSelectable);
  if (selectable.length === 1) return selectable[0].id;
  return "";
}

/**
 * Pin-as-suggestion (spec 2026-09-02 §1, replacing the anchor-with-override
 * semantics): while the user has NOT picked a node since the last profile
 * change, an EARNED suggestion owns the pick. The caller earns it — the row
 * is visible, selectable, and actually compatible — so a suggestion never
 * parks the form on an offline or incompatible node (the old anchor kept an
 * offline pin selected; the override era ended with the hint that carried
 * it). An unearned suggestion releases back to "local" only while it still
 * owns the pick; anything the user touched stays touched. Pure, like
 * `pickNodeDefault`. NOT mirrored 1:1 on mobile: `src/lib/node-anchor.ts`
 * keeps the pre-rename `anchorDecision` semantics deliberately (spec §6
 * non-goal) — do not blind-sync.
 */
export function suggestDecision(p: {
  /** The earned suggestion row (pinned node, visible, selectable, compatible); null otherwise */
  suggestion: Node | null;
  /** The user picked a node through the picker since the last profile change */
  explicit: boolean;
  /** The pick currently held by the form */
  current: string;
  /** What the suggestion auto-selected last, if it still owns the pick */
  anchoredTo: string | null;
}): { nodeId: string; anchoredTo: string | null } {
  if (p.suggestion && !p.explicit) return { nodeId: p.suggestion.id, anchoredTo: p.suggestion.id };
  if (!p.suggestion && !p.explicit && p.anchoredTo !== null && p.current === p.anchoredTo) {
    return { nodeId: "local", anchoredTo: null };
  }
  return { nodeId: p.current, anchoredTo: p.anchoredTo };
}

/**
 * Element ids of the form fields, for `htmlFor`/`id` association. The ids
 * now anchor the searchable inputs; both sets are e2e-pinned (tests/05 for
 * the dialog's, tests/06 for the page's).
 */
export interface NewSubshellFormIds {
  /** Profile combobox input */
  profile: string;
  /** Working-directory input */
  workingDir: string;
  /** Name input */
  name: string;
  /** Node combobox input */
  node: string;
}

const DIALOG_IDS: NewSubshellFormIds = {
  profile: "picker-profile",
  workingDir: "picker-working-dir",
  name: "picker-subshell-name",
  node: "picker-node",
};

/**
 * Node + profile + working directory + optional name — the form both launch
 * paths render: `/new` and the workspace dialog. State lives in the caller
 * (so each can gate and reset its own submit), this file owns the layout and
 * the pairing. Node sits first — the original ask (spec 2026-09-02) — but
 * either picker may be touched first: each selection re-filters the other
 * list LIVE (incompatible options grey out with a reason, never vanish —
 * `lib/subshell-compat`), and the server's 409 `harness_disabled` stays the
 * authoritative backstop for anything the cached views got wrong. A pinned
 * profile only SUGGESTS its node (earned: visible, online, compatible) and
 * the visible pick always rides the wire (`toSubshellCreateBody`).
 */
export function NewSubshellForm({
  value,
  onChange,
  ids = DIALOG_IDS,
}: {
  value: NewSubshellFormValue;
  onChange: (value: NewSubshellFormValue) => void;
  /** Field element ids; defaults to the dialog's (e2e-pinned) set. */
  ids?: NewSubshellFormIds;
}): JSX.Element {
  // `node=any`: profiles that only run on OTHER nodes must be listable here.
  const { data: profiles } = useProfiles({ node: "any" });

  // Working-dir pre-fill (most recent path for the selected node) — applied
  // once per mount and only while the field is empty, so it never fights the
  // caller's state or deliberate typing. A mid-mount node switch refreshes
  // the list without yanking typed/committed input.
  const { data: recent } = useRecentPaths(value.nodeId);
  const prefillDoneRef = useRef(false);

  const { data: nodeData } = useNodes();
  // A well-formed registry response is `{ nodes: [...] }`; anything else
  // (an error body, an older stub) leaves the current pick untouched.
  const nodes = Array.isArray(nodeData?.nodes) ? nodeData.nodes : null;

  const selectedProfile: LaunchProfile | undefined = (profiles ?? []).find((p) => p.id === value.profileId);
  const selectedNode: Node | null = (nodes ?? []).find((n) => n.id === value.nodeId) ?? null;

  // The pinned node's row — earned as a SUGGESTION only when it is also
  // selectable and compatible. A pin to `local` is the default anyway —
  // treated as no pin everywhere.
  const pinnedId = selectedProfile?.nodeId ?? null;
  const pinnedRow = pinnedId && pinnedId !== "local" ? ((nodes ?? []).find((n) => n.id === pinnedId) ?? null) : null;
  const suggestion: Node | null =
    pinnedRow !== null &&
    selectedProfile !== undefined &&
    isSelectable(pinnedRow) &&
    harnessFitsNode(pinnedRow, selectedProfile.harnessId) === null
      ? pinnedRow
      : null;

  // What the suggestion auto-selected last; owned by the component, cleared
  // by `suggestDecision` when the suggestion stops being earned.
  const anchoredRef = useRef<string | null>(null);

  // ONE effect for all automatic corrections (pre-fill + suggestion + vanish
  // re-home): composing the final value once makes the old cross-effect
  // clobbering impossible. Runs only after the node list actually loads;
  // while it loads the default "local" stands (the server accepts it).
  useEffect(() => {
    let next = value;
    if (!prefillDoneRef.current) {
      const first = recent?.paths[0]?.path;
      if (first) {
        prefillDoneRef.current = true;
        if (next.workingDir === "") next = { ...next, workingDir: first };
      }
    }
    if (nodes) {
      const d = suggestDecision({
        suggestion,
        explicit: Boolean(value.nodeExplicit),
        current: next.nodeId,
        anchoredTo: anchoredRef.current,
      });
      anchoredRef.current = d.anchoredTo;
      if (d.nodeId !== next.nodeId) next = { ...next, nodeId: d.nodeId };
      // Re-home the pick when what it pointed at vanished (e.g. an admin
      // turned off local launching). Unconditional since the earned-gate:
      // a suggestion owning the pick is by construction selectable and in
      // `nodes`, so `pickNodeDefault` keeps it (the anchor era needed a
      // suppression here because an offline pin could hold the pick).
      const pick = pickNodeDefault(nodes, next.nodeId);
      if (pick !== next.nodeId) next = { ...next, nodeId: pick };
    }
    if (next !== value) onChange(next);
  }, [recent, nodes, suggestion, value, onChange]);

  const nodeOptions = buildNodeOptions(nodes ?? [], selectedProfile ?? null, suggestion?.id ?? null);
  // An unmade pick ("" ) never matches a row id, so selectedNode is already
  // null there — nothing extra to guard.
  const profileOptions = buildProfileOptions(profiles ?? [], selectedNode);

  // Honest dead-ends (spec §1): the pick stands, the pair cannot — say what
  // to fix and link there. Gate on LOADED, not non-empty: a loaded-zero list
  // is exactly the dead-end the hint names, while a still-loading one
  // (undefined/null) stays quiet — `every` on empty options is vacuously
  // true, so the loaded checks are load-bearing. Never while a side is
  // unchosen, and never for an offline agent: the row reasons already say
  // "node offline", so "no profiles run here" would misdiagnose a down host
  // as an empty one.
  const noProfilesHere =
    nodes !== null &&
    selectedNode !== null &&
    profiles !== undefined &&
    !isOfflineAgent(selectedNode) &&
    profileOptions.every((o) => o.disabled);
  const noNodeHere = nodes !== null && selectedProfile !== undefined && nodeOptions.every((o) => o.disabled);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={ids.node}>Node</Label>
        <SearchableSelect
          id={ids.node}
          value={value.nodeId}
          placeholder="Choose a node"
          options={nodeOptions}
          // A pick through this control is the user's own — it outranks the
          // profile pin's suggestion until the next profile change.
          onValueChange={(nodeId) => nodeId !== "" && onChange({ ...value, nodeId, nodeExplicit: true })}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={ids.profile}>Profile</Label>
        <SearchableSelect
          id={ids.profile}
          value={value.profileId}
          placeholder="Choose a profile"
          options={profileOptions}
          // A profile change re-opens the suggestion window (§ suggestDecision).
          onValueChange={(profileId) => profileId !== "" && onChange({ ...value, profileId, nodeExplicit: false })}
        />
        {noProfilesHere && selectedNode ? (
          <p className="text-muted-foreground text-xs">
            {"No profiles run on "}
            <Link to="/nodes/$id" params={{ id: selectedNode.id }} className="underline">
              {selectedNode.name}
            </Link>
            {" — enable a harness there or create a profile."}
          </p>
        ) : null}
        {noNodeHere && selectedProfile ? (
          <p className="text-muted-foreground text-xs">
            {`No available node runs ${selectedProfile.harnessId} — `}
            <Link to="/nodes" className="underline">
              check your nodes
            </Link>
            .
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor={ids.workingDir}>Working directory</Label>
        <WorkingDirField
          id={ids.workingDir}
          value={value.workingDir}
          onChange={(workingDir) => onChange({ ...value, workingDir })}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={ids.name}>Subshell name (optional)</Label>
        <Input
          id={ids.name}
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          maxLength={NAME_MAX_DEFAULT}
          placeholder="Defaults to date/time"
        />
      </div>
    </div>
  );
}
