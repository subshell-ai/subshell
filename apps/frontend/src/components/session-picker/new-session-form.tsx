import type { JSX } from "react";
import { useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WorkingDirField } from "@/components/working-dir-field";
import { useProfiles } from "@/hooks/use-profiles";
import { useRecentPaths } from "@/hooks/use-recent-paths";

/** The fields needed to launch a new session. */
export interface NewSessionFormValue {
  profileId: string;
  workingDir: string;
  name: string;
}

export function emptyNewSessionForm(): NewSessionFormValue {
  return { profileId: "", workingDir: "", name: "" };
}

/** True once the form has everything the create call requires. */
export function canSubmit(value: NewSessionFormValue): boolean {
  return Boolean(value.profileId) && Boolean(value.workingDir.trim());
}

/** Element ids of the three fields, for `htmlFor`/`id` association. */
export interface NewSessionFormIds {
  /** Profile select trigger */
  profile: string;
  /** Working-directory input */
  workingDir: string;
  /** Name input */
  name: string;
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
};

/**
 * Profile + working directory + optional name — the form both launch paths
 * render: `/new` and the workspace dialog. State lives in the caller (so
 * each can gate and reset its own submit), this file owns only the layout.
 * What happens after a successful create also lives in the caller — the page
 * navigates, the dialog attaches a pane — but both POST through the one
 * `useCreateSession` hook.
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
  useEffect(() => {
    if (prefillDoneRef.current) return;
    const first = recent?.paths[0]?.path;
    if (!first) return;
    prefillDoneRef.current = true;
    if (value.workingDir === "") onChange({ ...value, workingDir: first });
  }, [recent, value, onChange]);

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
