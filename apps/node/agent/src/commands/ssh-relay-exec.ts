import type { JsonValue, SshRelayCloseCommand, SshRelayOpenCommand } from "@internal/subshell-protocol";
import { log } from "../log.js";
import { readSshEnabled, sshAllowed } from "../ssh-enabled.js";
import type { CommandContext, CommandResult } from "./context.js";
import { type ARelaySessionArgs, type BRelaySessionArgs, openARelaySession, openBRelaySession } from "./ssh-relay.js";
import { SSH_GATE_REFUSAL } from "./ssh-shared.js";

/**
 * The two relay command arms (spec 2026-10-08 §5.1, Task 8 acceptance (a)):
 * the daemon-side executors the plane's signed `ssh_relay_open` /
 * `ssh_relay_close` land on. The mechanics they drive are T6/T7's reviewed
 * code ({@link openBRelaySession} / {@link openARelaySession} in
 * `ssh-relay.ts`); this file owns the DELIVERY decisions:
 *
 * - **Gate first, open only.** Every SSH arm consults this machine's
 *   `ssh_enabled` mirror before pairing mechanics (spec §4.3), and this one
 *   refuses {@link SSH_GATE_REFUSAL} exactly like the discovery arms. The
 *   CLOSE is deliberately NOT gated: a switch-off mid-session must still be
 *   able to end the session - teardown is not an SSH act (the
 *   `set_ssh_enabled` precedent), and refusing it would strand a bound proxy
 *   socket on a machine that has decided to stop serving SSH.
 * - **The A branch answers immediately, the probe runs off the chain**
 *   (Task 7's handoff, binding): `openARelaySession` awaits the numbering
 *   probe, which can worst-case run two ~10 s agent round trips against a
 *   hung agent. The daemon's executor chain serializes every command, so
 *   awaiting it here would park `input`, `capture`, and every unrelated
 *   command behind someone else's agent. The ack says what it means -
 *   `pending: true`, the pairing is DELIVERED, not yet PROBED. A named
 *   refusal that arrives after the ack (a MOVED pin, an owned ref) is a log
 *   fact and a dead session the plane's cuts end; §4.5 makes re-pair an
 *   operator act at the machine, and the answer's absence (never a frame
 * from the responder) is what B's side reads as the refusal.
 * - **The B branch answers with its socket path.** Binding is local and fast,
 *   so it runs ON the chain and answers `socketPath` - which the plane
 *   re-derives from its own facts and byte-checks (the launch-config
 *   doctrine restated for the agent socket). The pane comes from the COMMAND
 *   (`cmd.paneId`, grammar (b)), never a launch-side correlation.
 * - **The pump is the daemon's** (`ctx.relay.sendRelayFrame`), forwarded to
 *   both branches unchanged: its deliver-or-throw contract (acceptance (c))
 *   is the daemon's `relay-send.ts`, and a context built without the relay
 *   plumbing refuses loudly instead of half-opening.
 *
 * The seams (`{@link RelayOpenSeams}`) exist for the probe-off-chain and
 * refusal-observability tests; production omits them and gets the real pair.
 */

/** Injectable pairing seams (test-only; production is the T6/T7 pair). */
export interface RelayOpenSeams {
  openA(args: ARelaySessionArgs): Promise<{ relayId: string }>;
  openB(args: BRelaySessionArgs): Promise<{ socketPath: string }>;
  /** Line sink for the detached A-branch's outcome (defaults to the agent log). */
  log?: (line: string) => void;
}

/** Does this machine permit SSH right now? (the one question every SSH arm asks first) */
function gateOpen(ctx: CommandContext): boolean {
  return sshAllowed(readSshEnabled(ctx.config.dataDir));
}

/** Execute `ssh_relay_open`: branch on the command's own `role`. */
export async function execSshRelayOpen(
  ctx: CommandContext,
  cmd: SshRelayOpenCommand,
  seams?: RelayOpenSeams,
): Promise<CommandResult> {
  if (!gateOpen(ctx)) return { ok: false, error: SSH_GATE_REFUSAL };
  const relay = ctx.relay;
  if (!relay) {
    // Not a user-facing condition: a daemon that runs commands without the
    // relay plumbing would half-open sessions with no pump, so this is the
    // impossible-state guard, answered loudly.
    return { ok: false, error: "relay plumbing unavailable in this daemon context" };
  }
  const say = seams?.log ?? ((line: string): void => log(line));
  if (cmd.role === "A") {
    const openA = seams?.openA ?? openARelaySession;
    // OFF the chain, deliberately (the module doc names the cost). The guard
    // refusals inside openARelaySession (role/self/pin/ref) become log lines
    // here, never a second answer to the plane - the ack already left.
    void openA({
      relay: relay.sessions,
      dataDir: ctx.config.dataDir,
      selfNodeId: ctx.config.nodeId,
      cmd,
      sendRelayFrame: relay.sendRelayFrame,
    }).then(
      (r) => say(`relay session ${cmd.ref}: A side live (relay ${r.relayId})`),
      (err: unknown) => say(`relay session ${cmd.ref}: A open refused after ack: ${String(err)}`),
    );
    // The seam cast is the JSON-safety posture the sibling executors use
    // (`node-results.ts` owns the answer contract; a relay ack is a plain
    // object by the plan's interface note).
    return { ok: true, data: { role: "A", relayId: cmd.relayId, pending: true } as unknown as JsonValue };
  }
  const openB = seams?.openB ?? openBRelaySession;
  try {
    const { socketPath } = await openB({
      relay: relay.sessions,
      dataDir: ctx.config.dataDir,
      selfNodeId: ctx.config.nodeId,
      paneId: cmd.paneId,
      cmd,
      sendRelayFrame: relay.sendRelayFrame,
    });
    return { ok: true, data: { role: "B", relayId: cmd.relayId, socketPath } as unknown as JsonValue };
  } catch (err: unknown) {
    // Named refusals (MOVED pin, malformed peer key, owned ref): the plane's
    // openRelay turns the rejection into its own named refusal. The string
    // travels the RESULT channel only - openBRelaySession's refusals name
    // ids and the §4.5 remedy, never key material.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Execute `ssh_relay_close`: stop the session named by the ref and hand the
 * named reason to the local owner (§5.6's endpoint line). Ungated by design
 * (module doc). An unknown ref answers `closed: false` - a close racing the
 * plane's own cut is routine, and a false answer to a redundant close is the
 * honest record, not an error.
 */
export function execSshRelayClose(ctx: CommandContext, cmd: SshRelayCloseCommand): CommandResult {
  const relay = ctx.relay;
  if (!relay) return { ok: false, error: "relay plumbing unavailable in this daemon context" };
  const closed = relay.sessions.close(cmd.ref, cmd.reason);
  return { ok: true, data: { ref: cmd.ref, closed } as unknown as JsonValue };
}
