import type { JSX } from "react";
import { useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WorkingDirField } from "@/components/working-dir-field";
import { useNodes } from "@/hooks/use-nodes";
import { useProfiles } from "@/hooks/use-profiles";
import { useRecentPaths } from "@/hooks/use-recent-paths";
import { nodeOptionLabel } from "@/lib/node-label";
import type { Node } from "@/types/node";

/** The fields needed to launch a new session. */
export interface NewSessionFormValue {
  profileId: string;
  workingDir: string;
  name: string;
  /**
   * Launch node — defaults to "local" (the control-plane host). "" means no
   * valid choice is made yet (local vanished from the list with several other
   * nodes around), which blocks submit until the user picks one. A pinned
   * profile re-anchors this to its node until the user makes an explicit pick
   * (see `anchorDecision`).
   */
  nodeId: string;
  /**
   * True once the user picks a node through the picker; cleared on every
   * profile change. Distinguishes a user's own pick from an auto-anchor —
   * a user who deliberately picks Local stays on Local (the server then
   * re-applies the pin; the inline hint says so).
   */
  nodeExplicit?: boolean;
}

export function emptyNewSessionForm(): NewSessionFormValue {
  return { profileId: "", workingDir: "", name: "", nodeId: "local" };
}

/** True once the form has everything the create call requires. */
export function canSubmit(value: NewSessionFormValue): boolean {
  return Boolean(value.profileId) && Boolean(value.workingDir.trim()) && Boolean(value.nodeId);
}

/**
 * Whether a node is pickable right now: ANY visible node grants launch
 * (`nodeCanLaunch` — deliberately not the session rule, spec §2), but an
 * OFFLINE agent is shown disabled: launching there 409s `NODE_OFFLINE`, and
 * offering a target we know is down would only invite a confusing failure.
 * (The pick list can always be stale — the 409 path covers the race.)
 * Mirrored in mobile `src/lib/node-anchor.ts`.
 */
function isSelectable(n: Node): boolean {
  return n.kind === "local" || n.status === "online";
}

/**
 * The node the picker should hold once the list has loaded: keep the current
 * pick while it stays selectable; else fall to "local" is impossible and
 * exactly one option remains (auto-pick — not a decision worth forcing); else
 * "" — an explicit choice is due (submit stays blocked until it happens).
 * Pure so the fallback matrix is testable without opening a Base UI dropdown.
 * Mirrored in mobile `src/lib/node-anchor.ts`.
 */
export function pickNodeDefault(nodes: Node[], current: string): string {
  if (nodes.some((n) => n.id === current && isSelectable(n))) return current;
  const selectable = nodes.filter(isSelectable);
  if (selectable.length === 1) return selectable[0].id;
  return "";
}

/**
 * Pinned-profile re-anchor (spec §6.6, UI side): when the selected profile
 * pins a launch node and the user has NOT picked a node since the profile
 * change, the picker holds the pinned node — shown as selected, offline and
 * all, so a pinned-offline launch 409s exactly where the picker points.
 * The wire rule is unchanged (`toSessionCreateBody`): this merely makes the
 * explicit pick honest — a pinned launch now forwards the pinned id instead
 * of omitting it and letting the pin land invisibly. An anchor the user's
 * pick replaces stays replaced (Local included); an anchor that stops being
 * earned — profile switched to an unpinned one, or the pin vanished from the
 * list — releases the pick back to "local", because it was never the user's.
 * Pure, like `pickNodeDefault`, so the matrix is testable without opening a
 * Base UI dropdown. Mirrored in mobile `src/lib/node-anchor.ts`.
 */
export function anchorDecision(p: {
  /** The profile's pinned node row (list loaded, id present, not `local`); null otherwise */
  pinRow: Node | null;
  /** The user picked a node through the picker since the last profile change */
  explicit: boolean;
  /** The pick currently held by the form */
  current: string;
  /** What the anchor auto-selected last, if it still owns the pick */
  anchoredTo: string | null;
}): { nodeId: string; anchoredTo: string | null } {
  if (p.pinRow && !p.explicit) return { nodeId: p.pinRow.id, anchoredTo: p.pinRow.id };
  if (!p.pinRow && !p.explicit && p.anchoredTo !== null && p.current === p.anchoredTo) {
    return { nodeId: "local", anchoredTo: null };
  }
  return { nodeId: p.current, anchoredTo: p.anchoredTo };
}

/** Element ids of the form fields, for `htmlFor`/`id` association. */
export interface NewSessionFormIds {
  /** Profile select trigger */
  profile: string;
  /** Working-directory input */
  workingDir: string;
  /** Name input */
  name: string;
  /** Node select trigger */
  node: string;
}

/**
 * The ids the workspace dialog has always used — `e2e/tests/05` locates all
 * three inside the dialog, so they are load-bearing. `/new` overrides them
 * via the `ids` prop because its own ids are pinned by `e2e/tests/06`.
 */
const DIALOG_IDS: NewSessionFormIds = {
  profile: "picker-profile",
  workingDir: "picker-working-dir",
  name: "picker-session-name",
  node: "picker-node",
};

/**
 * Profile + node + working directory + optional name — the form both launch
 * paths render: `/new` and the workspace dialog. State lives in the caller (so
 * each can gate and reset its own submit), this file owns only the layout.
 * What happens after a successful create also lives in the caller — the page
 * navigates, the dialog attaches a pane — but both POST through the one
 * `useCreateSession` hook.
 *
 * The node picker (spec 2026-08-31 §9) defaults to `local`; a remote pick is
 * real (spec §6.6) — the id rides the POST and the server resolves it against
 * the registry, so the picker is a launch-target chooser, not a hint. An
 * offline agent is disabled; a node that went down since the list loaded
 * surfaces as the caller's inline 409 copy. A profile that pins a node
 * re-anchors the picker to that node until the user overrides it (`anchorDecision`)
 * — with one exception kept visible on purpose: an anchored OFFLINE pin stays
 * selected, so the launch 409 matches the displayed target; and if the user
 * goes back to Local on a pinned profile, the inline hint says the pin will
 * override it (the wire stays honest: Local is sent as an omission and the
 * server re-applies the pin).
 */
export function NewSessionForm({
  value,
  onChange,
  ids = DIALOG_IDS,
}: {
  value: NewSessionFormValue;
  onChange: (value: NewSessionFormValue) => void;
  /** Field element ids; defaults to the dialog's (e2e-pinned) set. */
  ids?: NewSessionFormIds;
}): JSX.Element {
  const { data: profiles } = useProfiles();

  // Pre-fill the working directory with the most recent one the user
  // actually launched a session in — the answer is nearly always the same
  // project twice. Applied once per mount and only while the field is still
  // empty, so it never fights the caller's own state or deliberate typing
  // (including clearing the field after a pre-fill). Recents follow the
  // selected node, but the pre-fill intentionally stays mount-scoped: a
  // mid-mount node switch refreshes the list without ever yanking
  // typed/committed input.
  const { data: recent } = useRecentPaths(value.nodeId);
  const prefillDoneRef = useRef(false);

  // Node options: every VISIBLE node (any share grants launch). A failed or
  // empty registry must not break launching — the default "local" simply
  // stands (the server accepts "local" without consulting the registry).
  const { data: nodeData } = useNodes();
  // A well-formed registry response is `{ nodes: [...] }`; anything else (an
  // error body, an older stub) leaves the current pick untouched.
  const nodes = Array.isArray(nodeData?.nodes) ? nodeData.nodes : null;

  // The selected profile's pin, resolved to a row when the list carries it.
  // A pin to `local` is the default anyway — treated as no pin everywhere.
  const pinnedNodeId = (profiles ?? []).find((p) => p.id === value.profileId)?.nodeId ?? null;
  const pinRow =
    nodes && pinnedNodeId && pinnedNodeId !== "local" ? (nodes.find((n) => n.id === pinnedNodeId) ?? null) : null;
  // What the anchor auto-selected last; owned by the component, cleared by
  // `anchorDecision` when the anchor stops being earned.
  const anchoredRef = useRef<string | null>(null);

  // ONE effect for all automatic corrections. They used to be separate
  // effects, and when the two queries landed on the same commit the node
  // re-anchor (computed from the same stale `value`) clobbered the
  // working-dir pre-fill — composing the final value once here makes that
  // impossible.
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
      // Pinned-profile re-anchor: hold the pick on the profile's node until
      // the user overrides it. Runs BEFORE the vanish re-home below, and
      // suppresses it while active: a pinned OFFLINE row is not "selectable"
      // by `isSelectable`, but dropping it would hide the very target the
      // launch will 409 on — show it selected instead.
      const d = anchorDecision({
        pinRow,
        explicit: Boolean(value.nodeExplicit),
        current: next.nodeId,
        anchoredTo: anchoredRef.current,
      });
      anchoredRef.current = d.anchoredTo;
      if (d.nodeId !== next.nodeId) next = { ...next, nodeId: d.nodeId };
      // Re-home the pick when what it pointed at vanished (e.g. an admin
      // turned off local launching). Only once the list actually loaded.
      if (!(pinRow && !value.nodeExplicit)) {
        const pick = pickNodeDefault(nodes, next.nodeId);
        if (pick !== next.nodeId) next = { ...next, nodeId: pick };
      }
    }
    if (next !== value) onChange(next);
  }, [recent, nodes, pinRow, value, onChange]);

  const options = nodes ?? [];

  // The pin is invisible only while it is not the pick: Local (or an
  // unmade pick) on a pinned profile means the server will re-apply the
  // pin — say so rather than let the picker lie by omission.
  const pinOverridesLocal = pinnedNodeId !== null && pinnedNodeId !== "local" && value.nodeId === "local";

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={ids.profile}>Profile</Label>
        <Select
          value={value.profileId}
          // Base UI select values widen to `Value | null`; never null here.
          // A profile change clears the explicit-node flag: every pin starts
          // with a fresh anchor ("explicit pick SINCE the profile change").
          onValueChange={(profileId) => profileId !== null && onChange({ ...value, profileId, nodeExplicit: false })}
          // Base UI's Value prints the raw value without this map; the label
          // format must match the item text below (e2e asserts on it).
          items={(profiles ?? []).map((p) => ({ value: p.id, label: `${p.name} (${p.harnessId})` }))}
        >
          <SelectTrigger id={ids.profile}>
            <SelectValue placeholder="Choose a profile" />
          </SelectTrigger>
          <SelectContent>
            {profiles?.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name} ({p.harnessId})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor={ids.node}>Node</Label>
        <Select
          value={value.nodeId}
          // A pick through this control is the user's own — it outranks the
          // profile pin's anchor until the next profile change.
          onValueChange={(nodeId) => nodeId !== null && onChange({ ...value, nodeId, nodeExplicit: true })}
          items={options.map((n) => ({
            value: n.id,
            label: nodeOptionLabel(n, "Local"),
          }))}
        >
          <SelectTrigger id={ids.node}>
            <SelectValue placeholder="Choose a node" />
          </SelectTrigger>
          <SelectContent>
            {options.map((n) => (
              <SelectItem key={n.id} value={n.id} disabled={!isSelectable(n)}>
                {nodeOptionLabel(n, "Local")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {pinOverridesLocal ? (
          // One template literal so the hint is a single text node (test- and
          // screen-reader-friendly). The node may be gone from the list (pin
          // id still drives the server's resolve path) — fall back to prose.
          <p className="text-muted-foreground text-xs">
            {`This profile runs on ${pinRow?.name ?? "another node"} — it overrides Local.`}
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
        <Label htmlFor={ids.name}>Session name (optional)</Label>
        <Input
          id={ids.name}
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          placeholder="Defaults to date/time"
        />
      </div>
    </div>
  );
}
