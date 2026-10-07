import { Button, errMessage, Label } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ConnectJourney } from "@/components/connect/connect-journey";
import { DirBrowser } from "@/components/connect/dir-browser";
import { PromptStackSection } from "@/components/prompts/prompt-stack-section";
import {
  DIALOG_IDS,
  type NewSubshellFormIds,
  type NewSubshellFormValue,
} from "@/components/subshell-picker/launch-form-rules";
import { SearchableSelect } from "@/components/ui/combobox";
import { useNodes } from "@/hooks/use-nodes";
import { usePresets } from "@/hooks/use-presets";
import { useSshDetectHarnesses, useSshSessionHarnesses, useSshSessions } from "@/hooks/use-ssh-runtime";
import { wireToPresetBlocks } from "@/lib/prompt-stack";
import { destinationLabel, type SshRuntimeSessionView } from "@/lib/ssh-runtime";

/** Remote location selection inside the shared standalone/workspace launch form. */
export function SshLaunchForm({
  value,
  onChange,
  ids = DIALOG_IDS,
  onLeave,
}: {
  value: NewSubshellFormValue;
  onChange: (value: NewSubshellFormValue) => void;
  ids?: NewSubshellFormIds;
  onLeave?: () => void;
}) {
  const sessions = useSshSessions(true);
  const nodes = useNodes();
  const [opened, setOpened] = useState<SshRuntimeSessionView | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [prefill, setPrefill] = useState<{ nodeId: string; alias: string } | null>(null);
  const session =
    sessions.data?.sessions.find((s) => s.id === value.sshSessionId) ??
    (opened?.id === value.sshSessionId ? opened : null);

  useEffect(() => {
    if (session && session.status !== "active" && value.nodeId) onChange({ ...value, nodeId: "", workingDir: "" });
  }, [session, value, onChange]);

  function choose(s: SshRuntimeSessionView) {
    setOpened(s);
    setConnecting(false);
    onChange({ ...value, sshSessionId: s.id, nodeId: s.runtimeNodeId, workingDir: "", harnessId: "", presetId: null });
  }

  if (session?.status === "active") {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-2 rounded-md border p-3">
          <div>
            <p className="font-strong text-label">{session.alias}</p>
            <p className="text-detail text-muted-foreground">
              {destinationLabel(session)} · via{" "}
              {nodes.data?.nodes.find((n) => n.id === session.connectingNodeId)?.name ?? "connecting machine"}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange({ ...value, sshSessionId: "", nodeId: "", workingDir: "" })}
          >
            Change host
          </Button>
        </div>
        <RemoteLaunchFields key={session.id} session={session} value={value} onChange={onChange} ids={ids} />
        <Link to="/connect" onClick={onLeave} className="text-detail text-muted-foreground underline">
          Manage SSH connections
        </Link>
      </div>
    );
  }

  const recent = sessions.data?.sessions.filter((s) => s.status !== "active" && s.connectingNodeId !== null) ?? [];
  const active = sessions.data?.sessions.filter((s) => s.status === "active") ?? [];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-detail text-muted-foreground">Open an agent or terminal in a folder on another machine.</p>
      {session && (
        <p role="status" className="text-detail text-muted-foreground">
          This connection has ended. Reconnect below before starting a subshell.
        </p>
      )}
      {sessions.isError && (
        <p role="alert" className="text-destructive text-detail">
          {errMessage(sessions.error, "Could not load SSH connections.")}{" "}
          <Button type="button" variant="link" onClick={() => void sessions.refetch()}>
            Retry
          </Button>
        </p>
      )}
      {active.length > 0 && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids.node}-ssh`}>Connected hosts</Label>
          <SearchableSelect
            id={`${ids.node}-ssh`}
            value=""
            consumed
            placeholder="Choose a connected host"
            options={active.map((s) => ({
              value: s.id,
              label: s.alias,
              reason: `${destinationLabel(s)} · via ${nodes.data?.nodes.find((n) => n.id === s.connectingNodeId)?.name ?? "connecting machine"}`,
            }))}
            onValueChange={(id) => {
              const s = active.find((s) => s.id === id);
              if (s) choose(s);
            }}
          />
        </div>
      )}
      {recent.length > 0 && !connecting && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids.node}-recent-ssh`}>Recent SSH hosts</Label>
          <SearchableSelect
            id={`${ids.node}-recent-ssh`}
            value=""
            consumed
            placeholder="Reconnect to a host"
            options={recent.map((s) => ({ value: s.id, label: s.alias, reason: destinationLabel(s) }))}
            onValueChange={(id) => {
              const s = recent.find((s) => s.id === id);
              if (s?.connectingNodeId) {
                setPrefill({ nodeId: s.connectingNodeId, alias: s.alias });
                setConnecting(true);
              }
            }}
          />
        </div>
      )}
      {active.length > 0 && !connecting ? (
        <Button type="button" variant="outline" onClick={() => setConnecting(true)}>
          Connect another host
        </Button>
      ) : (
        <ConnectJourney
          key={prefill ? `${prefill.nodeId}:${prefill.alias}` : "new"}
          prefill={prefill}
          onConnected={choose}
        />
      )}
      <Link to="/connect" onClick={onLeave} className="text-detail text-muted-foreground underline">
        Manage SSH connections and reconnect
      </Link>
    </div>
  );
}

/** The selected destination owns its folder and detected agents, never the connecting node. */
function RemoteLaunchFields({
  session,
  value,
  onChange,
  ids,
}: {
  session: SshRuntimeSessionView;
  value: NewSubshellFormValue;
  onChange: (value: NewSubshellFormValue) => void;
  ids: NewSubshellFormIds;
}) {
  const harnesses = useSshSessionHarnesses(session.id);
  const detect = useSshDetectHarnesses(session.id);
  const presets = usePresets();
  const detected = useRef(false);
  useEffect(() => {
    if (!detected.current) {
      detected.current = true;
      detect.mutate(undefined);
    }
  }, [detect.mutate]);
  const available = harnesses.data?.harnesses ?? [];
  const chosen = available.find((h) => h.harnessId === value.harnessId);
  // A carried-over local agent is never a valid choice until this destination answers.
  useEffect(() => {
    if (value.harnessId && harnesses.data && !chosen?.installed) onChange({ ...value, harnessId: "", presetId: null });
  }, [chosen, harnesses.data, value, onChange]);
  return (
    <div className="flex flex-col gap-4">
      <DirBrowser
        sessionId={session.id}
        host={session.alias}
        value={value.workingDir}
        onChange={(workingDir) => onChange({ ...value, workingDir })}
      />
      <div className="flex flex-col gap-2">
        <Label htmlFor={ids.preset}>Preset</Label>
        <SearchableSelect
          id={ids.preset}
          value=""
          consumed
          placeholder="Choose a preset (optional)"
          options={(presets.data ?? []).map((p) => ({
            value: p.id,
            label: p.name,
            disabled: !available.some((h) => h.harnessId === p.harnessId && h.installed),
            reason: p.harnessId,
          }))}
          onValueChange={(id) => {
            const preset = presets.data?.find((p) => p.id === id);
            if (preset)
              onChange({
                ...value,
                harnessId: preset.harnessId,
                presetId: preset.id,
                promptBlocks: wireToPresetBlocks(preset.promptBlocks),
              });
          }}
        />
        {value.presetId && (
          <p className="text-detail text-muted-foreground">
            Settings copied from {presets.data?.find((p) => p.id === value.presetId)?.name}. The SSH host and folder
            stay selected.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={ids.agent}>Agent</Label>
        <SearchableSelect
          id={ids.agent}
          value={value.harnessId}
          placeholder="Choose an agent or terminal"
          options={available.map((h) => ({
            value: h.harnessId,
            label: h.harnessName,
            disabled: !h.installed,
            reason: h.installed ? undefined : "Not installed on this host",
          }))}
          onValueChange={(harnessId) => onChange({ ...value, harnessId, presetId: null })}
        />
        <p className="text-detail text-muted-foreground">
          Runs on {session.alias}. Agent sign-in and files stay on that host.
        </p>
        {detect.isPending && (
          <p role="status" className="text-detail text-muted-foreground">
            Checking installed agents…
          </p>
        )}
        {(detect.isError || harnesses.isError) && (
          <p role="alert" className="text-destructive text-detail">
            Could not check installed agents.{" "}
            <Button type="button" variant="link" onClick={() => detect.mutate(undefined)}>
              Retry
            </Button>
          </p>
        )}
      </div>
      <PromptStackSection
        blocks={value.promptBlocks}
        onBlocksChange={(promptBlocks) => onChange({ ...value, promptBlocks })}
        addButtonId={ids.prompt}
      />
    </div>
  );
}
