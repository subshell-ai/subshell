import type {
  JoinInput,
  JoinOutcome,
  NetworkContext,
  NetworkPlugin,
  NetworkPluginFactory,
  NetworkStatus,
  PluginCapability,
  PluginHost,
  PublishOutcome,
  PublishRefusal,
} from "@subshell-ai/plugin-api";
import { joinNetwork } from "./join.js";
import { leaveNetwork, publishServer, unpublishServer } from "./publish.js";
import { readNetwork } from "./status.js";

/**
 * Built-in: NetBird, a private mesh this server can be reached over.
 *
 * A `network` plugin rather than a harness — it launches nothing in a pane, it
 * makes this machine reachable from the operator's other devices. The shape it
 * implements is {@link NetworkPlugin}, picked by the manifest's `type`.
 *
 * **It describes; the host executes.** Every verb below is one or two
 * `host.run` calls against the vendor CLI. Nothing here spawns a process, writes
 * a file, stores a credential or edits this server's configuration: publishing
 * returns the addresses it read and the host decides what to do with them. That
 * is what keeps an act performed by code we did not write as bounded and audited
 * as one we did.
 *
 * **Unlike Tailscale, publishing runs no command.** A NetBird join already makes
 * this machine reachable at its WireGuard address, so "publish" is the host-side
 * act of recording those addresses and admitting them to `TRUSTED_ORIGINS`. The
 * consequence is stated in {@link readNetwork}: the plugin can only ever observe
 * `joined`, because the joined/published distinction lives in the host's config,
 * which a plugin may not read. The manifest's `publishImplicit` flag is the
 * honest half of that: it tells the host to settle the distinction from its
 * own record rather than expecting the daemon to be asked a question it never
 * received.
 *
 * `host` carries what this module cannot import. See `@subshell-ai/plugin-api`.
 */
const createPlugin: NetworkPluginFactory = (host: PluginHost): NetworkPlugin => ({
  /**
   * `publish` (the pair), and nothing else.
   *
   * Not `supervise`: there is no long-running child to babysit — NetBird's daemon
   * is a service the operator installed, not a process this plugin spawns. Not
   * `guard`: NetBird is a private network of enrolled machines (the manifest says
   * `exposure: "private"`), so there is no front-door assertion to verify. And
   * not `settings` — which this plugin used to declare alongside a
   * `managementUrl` field (operator's ruling, 2026-09-16: "the user should
   * configure all of this in their own netbird cli setup"). The field was right
   * on the mechanism: it only ever fed `netbird up --management-url` AT JOIN;
   * post-join the daemon owns its own config, so the card's copy of it was a
   * dead input that could disagree with what the machine says. A self-hosted
   * operator runs `netbird setup`/`netbird up` on the machine, and this card
   * then reflects and publishes what the daemon reports. `capabilityMismatches`
   * pairs the capability with the declaration in both directions, so removing
   * one means removing the other — and the setup KEY survives untouched,
   * because it is the join credential, not configuration.
   */
  capabilities: (): PluginCapability[] => ["publish"],

  async status(ctx: NetworkContext): Promise<NetworkStatus> {
    return (await readNetwork(host, ctx)).status;
  },

  async join(input: JoinInput, ctx: NetworkContext): Promise<JoinOutcome> {
    return joinNetwork(host, input, ctx);
  },

  async leave(): Promise<void> {
    return leaveNetwork(host);
  },

  async publish(ctx: NetworkContext): Promise<PublishOutcome | PublishRefusal> {
    return publishServer(host, ctx);
  },

  async unpublish(): Promise<void> {
    return unpublishServer();
  },
});

export default createPlugin;
export { manifest } from "./manifest.js";
