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
   * nodes around), which blocks submit until the user picks one.
   */
  nodeId: string;
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
 */
export function pickNodeDefault(nodes: Node[], current: string): string {
  if (nodes.some((n) => n.id === current && isSelectable(n))) return current;
  const selectable = nodes.filter(isSelectable);
  if (selectable.length === 1) return selectable[0].id;
  return "";
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
 * surfaces as the caller's inline 409 copy.
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
  // (including clearing the field after a pre-fill).
  const { data: recent } = useRecentPaths();
  const prefillDoneRef = useRef(false);

  // Node options: every VISIBLE node (any share grants launch). A failed or
  // empty registry must not break launching — the default "local" simply
  // stands (the server accepts "local" without consulting the registry).
  const { data: nodeData } = useNodes();
  // A well-formed registry response is `{ nodes: [...] }`; anything else (an
  // error body, an older stub) leaves the current pick untouched.
  const nodes = Array.isArray(nodeData?.nodes) ? nodeData.nodes : null;

  // ONE effect for both automatic corrections. They used to be two effects,
  // and when the two queries landed on the same commit the node re-anchor
  // (computed from the same stale `value`) clobbered the working-dir
  // pre-fill — composing the final value once here makes that impossible.
  useEffect(() => {
    let next = value;
    if (!prefillDoneRef.current) {
      const first = recent?.paths[0]?.path;
      if (first) {
        prefillDoneRef.current = true;
        if (next.workingDir === "") next = { ...next, workingDir: first };
      }
    }
    // Re-home the pick when what it pointed at vanished (e.g. an admin turned
    // off local launching). Only once the list actually loaded.
    if (nodes) {
      const pick = pickNodeDefault(nodes, next.nodeId);
      if (pick !== next.nodeId) next = { ...next, nodeId: pick };
    }
    if (next !== value) onChange(next);
  }, [recent, nodes, value, onChange]);

  const options = nodes ?? [];

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={ids.profile}>Profile</Label>
        <Select
          value={value.profileId}
          // Base UI select values widen to `Value | null`; never null here.
          onValueChange={(profileId) => profileId !== null && onChange({ ...value, profileId })}
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
          onValueChange={(nodeId) => nodeId !== null && onChange({ ...value, nodeId })}
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
