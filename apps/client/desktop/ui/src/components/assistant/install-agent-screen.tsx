/**
 * Install the Agent — the screen for a machine with no usable `subshell`.
 *
 * Two very different situations reach it, and keeping them apart is the whole
 * care in this file: nothing on the ladder answered at all, and a binary that
 * answered `version` but not `status --json`. Reading the second as "not
 * enrolled" would route a transient read failure to the screen that overwrites
 * `config.json` and discards its node key, so the unconfirmed install is
 * offered ONLY when nothing answered — there is nothing to stop, overwrite or
 * downgrade in that case. Where an agent WAS resolved, replacing it is
 * `commands.updateAgent`, which asks first, and it is offered from the
 * connected screen rather than here.
 */
import { Rocket } from "lucide-react";
import { DetailsDisclosure } from "@/components/assistant/details-disclosure";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { Button } from "@/components/ui/button";
import type { NodeCommands } from "@/hooks/use-node-commands";
import type { ActionResult, EnrolledNodeBody, NodeSettings, Probe } from "@/lib/ipc";

export function InstallAgentScreen(props: {
  shell: FrameShell;
  probe: Probe | undefined;
  settings: NodeSettings | undefined;
  enrolledNode: EnrolledNodeBody | null;
  output: ActionResult | null;
  commands: NodeCommands;
  busy: boolean;
}) {
  const { shell, probe, settings, enrolledNode, output, commands, busy } = props;
  const answered = Boolean(probe?.agent);
  const canInstall = Boolean(probe?.bundledVersion) && !answered;

  return (
    <Frame
      {...shell}
      icon={<Rocket />}
      barLeft={
        <>
          <Button variant="ghost" disabled={busy} onClick={commands.pickBinary}>
            Choose an existing agent…
          </Button>
          {settings?.agentBinPath && (
            <Button variant="ghost" disabled={busy} onClick={commands.clearBinary}>
              Forget the chosen binary
            </Button>
          )}
        </>
      }
      barRight={
        canInstall ? (
          <Button className="min-w-[120px]" disabled={busy} onClick={commands.installAgent}>
            Install
          </Button>
        ) : (
          <Button className="min-w-[120px]" disabled={busy} onClick={commands.refresh}>
            Retry
          </Button>
        )
      }
    >
      <p className="text-muted-foreground text-sm leading-relaxed">
        {answered
          ? "Nothing has been changed. This app will not offer to register a machine whose agent cannot say whether " +
            "it is already a node: enrolling overwrites the existing configuration and discards its node key."
          : "The agent is the small program that holds this machine's connection to the control plane and starts the " +
            "sessions launched here. Installing it copies the copy that ships inside this app to " +
            "~/.local/bin/subshell, and nothing is downloaded."}
      </p>
      {!probe?.bundledVersion && (
        <p className="mt-3 text-muted-foreground text-detail">
          This build ships no agent, so an existing one has to be pointed at.
        </p>
      )}
      <DetailsDisclosure probe={probe} settings={settings} enrolledNode={enrolledNode} output={output} />
    </Frame>
  );
}
