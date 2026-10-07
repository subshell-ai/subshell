import { Button, errMessage, Label } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ConnectJourney } from "@/components/connect/connect-journey";
import { useDesktopBrokers } from "@/components/connect/desktop-broker-setup";
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
import { useConnectSshLocation, useSaveSshLocation, useSshLocations } from "@/hooks/use-ssh-locations";
import { useSshDetectHarnesses, useSshSessionHarnesses, useSshSessions } from "@/hooks/use-ssh-runtime";
import { makeForm, useSubmitDisabled } from "@/lib/form";
import { wireToPresetBlocks } from "@/lib/prompt-stack";
import { sshLocationProblems } from "@/lib/ssh-location-form";
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
  const locations = useSshLocations();
  const reconnect = useConnectSshLocation();
  const choice = useRef(0);
  useEffect(
    () => () => {
      choice.current += 1;
    },
    [],
  );
  const nodes = useNodes();
  const desktopBrokers = useDesktopBrokers();
  const originName = (id: string | null) =>
    nodes.data?.nodes.find((n) => n.id === id)?.name ??
    desktopBrokers.data?.brokers.find((b) => b.id === id)?.name ??
    "connecting machine";
  const [opened, setOpened] = useState<SshRuntimeSessionView | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [prefill, setPrefill] = useState<{ nodeId: string; alias: string } | null>(null);
  const session =
    sessions.data?.sessions.find((s) => s.id === value.sshSessionId) ??
    (opened?.id === value.sshSessionId ? opened : null);

  useEffect(() => {
    if (session && session.status !== "active" && value.nodeId) onChange({ ...value, nodeId: "", workingDir: "" });
  }, [session, value, onChange]);

  function choose(s: SshRuntimeSessionView, workingDir = "") {
    choice.current += 1;
    setOpened(s);
    setConnecting(false);
    onChange({ ...value, sshSessionId: s.id, nodeId: s.runtimeNodeId, workingDir, harnessId: "", presetId: null });
  }

  if (session?.status === "active") {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-2 rounded-md border p-3">
          <div>
            <p className="font-strong text-label">{session.alias}</p>
            <p className="text-detail text-muted-foreground">
              {destinationLabel(session)} · via {originName(session.connectingNodeId)}
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
        <Link to="/settings/connections" onClick={onLeave} className="text-detail text-muted-foreground underline">
          Manage SSH connections
        </Link>
      </div>
    );
  }

  const recent = sessions.data?.sessions.filter((s) => s.status !== "active" && s.connectingNodeId !== null) ?? [];
  const active = sessions.data?.sessions.filter((s) => s.status === "active") ?? [];
  const savedCount = locations.data?.locations.length ?? 0;
  // The shortcuts are the secondary path; the machine-and-destination journey is
  // the primary first read. The group appears only when there is something to
  // jump back into, so a fresh host with no history shows just the journey.
  const showQuick = active.length > 0 || savedCount > 0 || (recent.length > 0 && !connecting);
  return (
    <div className="flex flex-col gap-4">
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

      {/* Primary: the machine that makes the SSH connection, then its host and folder. */}
      {active.length > 0 && !connecting ? (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          onClick={() => {
            choice.current += 1;
            setConnecting(true);
          }}
        >
          Connect another host
        </Button>
      ) : (
        <ConnectJourney
          key={prefill ? `${prefill.nodeId}:${prefill.alias}` : "new"}
          prefill={prefill}
          onConnected={choose}
        />
      )}

      {/* Secondary: one-click shortcuts back into something already known. */}
      {showQuick && (
        <div className="flex flex-col gap-3 border-t pt-3">
          <div className="flex flex-col gap-0.5">
            <p className="font-strong text-label">Quick connect</p>
            <p className="text-detail text-muted-foreground">
              Reconnect to a host or folder you have used before. Choosing one sets up the connection for you.
            </p>
          </div>
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
                  reason: `${destinationLabel(s)} · via ${originName(s.connectingNodeId)}`,
                }))}
                onValueChange={(id) => {
                  const s = active.find((s) => s.id === id);
                  if (s) choose(s);
                }}
              />
            </div>
          )}
          {savedCount > 0 && (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${ids.node}-saved-ssh`}>Saved remote locations</Label>
              <SearchableSelect
                id={`${ids.node}-saved-ssh`}
                value=""
                consumed
                placeholder={reconnect.isPending ? "Connecting…" : "Choose a saved host and folder"}
                options={(locations.data?.locations ?? []).map((l) => ({
                  value: l.id,
                  label: `${l.alias} · ${l.path}`,
                  reason: `${destinationLabel(l)} · via ${originName(l.originId)}`,
                  disabled: reconnect.isPending,
                }))}
                onValueChange={(id) => {
                  const request = ++choice.current;
                  reconnect.mutate(id, {
                    onSuccess: ({ session, location }) => {
                      if (choice.current === request) choose(session, location.path);
                    },
                  });
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
                    choice.current += 1;
                    setPrefill({ nodeId: s.connectingNodeId, alias: s.alias });
                    setConnecting(true);
                  }
                }}
              />
            </div>
          )}
          {(locations.isError || reconnect.isError) && (
            <p role="alert" className="text-destructive text-detail">
              {errMessage(reconnect.error ?? locations.error, "Could not load saved locations.")}
            </p>
          )}
        </div>
      )}

      <Link to="/settings/connections" onClick={onLeave} className="text-detail text-muted-foreground underline">
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
  const save = useSaveSshLocation();
  const saveForm = makeForm({
    defaultValues: { path: value.workingDir },
    validator: sshLocationProblems,
    onSubmit: ({ path }) => {
      if (save.isPending || Object.keys(sshLocationProblems({ path })).length > 0) return;
      save.mutate({ sessionId: session.id, path });
    },
  });
  useEffect(() => {
    saveForm.setFieldValue("path", value.workingDir);
  }, [saveForm, value.workingDir]);
  const saveDisabled = useSubmitDisabled(saveForm, save.isPending);
  const savePathProblem = sshLocationProblems({ path: value.workingDir }).path;
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
        id={ids.workingDir}
        value={value.workingDir}
        onChange={(workingDir) => onChange({ ...value, workingDir })}
      />
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={saveDisabled}
          onClick={() => {
            if (save.isPending || Object.keys(sshLocationProblems({ path: value.workingDir })).length > 0) return;
            void saveForm.handleSubmit();
          }}
        >
          Remember this host and folder
        </Button>
        {save.isSuccess && (
          <p role="status" className="text-detail text-muted-foreground">
            Location saved.
          </p>
        )}
      </div>
      {savePathProblem && <p className="text-detail text-muted-foreground">{savePathProblem}</p>}
      {save.isError && (
        <p role="alert" className="text-destructive text-detail">
          {errMessage(save.error, "Could not save this location.")}
        </p>
      )}
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
