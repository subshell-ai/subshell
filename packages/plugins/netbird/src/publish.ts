import type { NetworkContext, NetworkState, PluginHost, PublishOutcome, PublishRefusal } from "@subshell-ai/plugin-api";
import { firstLine, resolveBinary, runNetbird } from "./cli.js";
import { readNetwork } from "./status.js";

/** Best-effort verbs get the default deadline; they run instantly when the daemon is there. */
const LEAVE_TIMEOUT_MS = 30_000;

/** One sentence per state this machine can be in that is not ready to publish. */
const NOT_READY: Partial<Record<NetworkState, string>> = {
  "not-installed": "NetBird is not installed on this machine, so there is nothing to publish on.",
  "daemon-down": "The NetBird daemon is not running or not reachable, so this server cannot be published yet.",
  "needs-login": "This machine is not on your NetBird network yet. Join one first, then publish.",
};

/**
 * Publishes this server on the NetBird network — by doing nothing to NetBird.
 *
 * A join is already enough for reachability: the peer has a WireGuard address
 * and the server is listening on every interface, so the address a device on the
 * NetBird network dials is already answered. What `publish` adds is not a
 * daemon-side change but the host-side one — recording these addresses and
 * letting them into `TRUSTED_ORIGINS`. The plugin therefore runs NO command and
 * returns the addresses the status already saw.
 *
 * The nameserver-group caveat is NOT emitted from here: a {@link PublishOutcome}
 * carries no hints, only addresses. It rides on `status` instead, which is where
 * Tailscale's disclosure hints live too, so it renders beside the address list
 * before and after the publish alike.
 *
 * Refuses for anything short of `joined`, and for a joined machine that reported
 * no address at all (nothing to hand out), rather than fabricating a publish.
 *
 * **Pressing twice means what pressing once means.** The verb is a pure read:
 * the same joined machine answers with the same addresses every time, the host
 * rewrites its record to the same effect, and a union with a set it already
 * holds writes nothing new. There is therefore no "recorded" second press to
 * announce — an already-published NetBird is simply ALREADY REACHABLE HERE,
 * which is what the page says. What the host makes of a second identical
 * record is the host's § 5.3 business; this verb never sees it.
 */
export async function publishServer(host: PluginHost, ctx: NetworkContext): Promise<PublishOutcome | PublishRefusal> {
  const read = await readNetwork(host, ctx);

  const notReady = NOT_READY[read.status.state];
  if (notReady) {
    const hint = read.status.hints[0];
    return {
      refused: {
        text: notReady,
        ...(hint?.command ? { command: hint.command } : {}),
        ...(hint?.docsUrl ? { docsUrl: hint.docsUrl } : {}),
        ...(hint?.privileged ? { privileged: true } : {}),
      },
    };
  }

  if (read.status.addresses.length === 0) {
    return {
      refused: {
        text: "NetBird reported this machine as connected but gave no address to publish it at, so nothing was published.",
      },
    };
  }

  // The same addresses the status read listed. `readNetwork` already decided the
  // order (FQDN then IP), so this hands back what a page is already showing.
  return { addresses: read.status.addresses };
}

/**
 * Takes the publish down. There is nothing on the machine to undo.
 *
 * A join is not undone here (§ 5): the addresses stay reachable because they
 * were reachable before the publish. What the HOST does on this call is its
 * own § 5.3 business (reversed 2026-09-16): it clears the publish record and
 * subtracts the trusted origins the publish added, so the address stops
 * ACCEPTING sign-ins at the next restart even though this daemon goes on
 * answering while the machine stays a member. This plugin's half stays the
 * clean no-op it always was; the reversibility it never had is the host's to
 * undo now.
 */
export async function unpublishServer(): Promise<void> {
  // Deliberately does nothing. NetBird's reachability is a property of the join,
  // not of anything `publishServer` created.
}

/**
 * Takes this machine off the NetBird network.
 *
 * Best-effort by contract: a machine already off the network, or whose daemon is
 * gone, is not an error — there is nothing left to leave.
 */
export async function leaveNetwork(host: PluginHost): Promise<void> {
  const binary = await resolveBinary(host);
  if (!binary) return;
  const result = await runNetbird(host, binary, ["down"], { timeoutMs: LEAVE_TIMEOUT_MS });
  if (result.code !== 0) host.log.warn(`netbird down exited ${result.code}: ${firstLine(result.stderr)}`);
}
