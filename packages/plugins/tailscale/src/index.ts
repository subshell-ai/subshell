import type {
  JoinInput,
  JoinOutcome,
  NetworkContext,
  NetworkPlugin,
  NetworkStatus,
  PluginCapability,
  PluginFactory,
  PluginHost,
  PublishOutcome,
  PublishRefusal,
} from "@subshell-ai/plugin-api";
import { joinTailnet } from "./join.js";
import { leaveTailnet, publishServer, unpublishServer } from "./publish.js";
import { readNetwork } from "./status.js";

/**
 * Built-in: Tailscale, a private mesh this server can be reached over.
 *
 * A `network` plugin rather than a harness — it launches nothing in a pane, it
 * makes this machine reachable from the operator's other devices. The shape it
 * implements is {@link NetworkPlugin}, picked by the manifest's `type`.
 *
 * **It describes; the host executes.** Every verb below is one or two
 * `host.run` calls against the vendor CLI. Nothing here spawns a process,
 * writes a file, stores a credential or edits this server's configuration:
 * publishing returns the address it produced and the host decides what to do
 * with it. That is what keeps an act performed by code we did not write as
 * bounded and audited as one we did.
 *
 * **It holds no state.** The port, the settings and the secrets all arrive in
 * {@link NetworkContext} on every call, and where the machine stands is read
 * from Tailscale itself each time rather than remembered — so a plugin
 * reloaded mid-life behaves exactly like one that has been running since boot,
 * and a `tailscale down` typed at the machine is visible on the next read.
 *
 * Identity, platforms, exposure and the privileged setup steps live in this
 * package's package.json `subshell` block, NOT here: a page renders "not
 * available on this platform" and prints the two sudo commands without
 * importing a line of this file.
 *
 * `host` carries what this module cannot import. See `@subshell-ai/plugin-api`.
 */
const createPlugin: PluginFactory = (host: PluginHost): NetworkPlugin => ({
  /**
   * `publish` only, and it is the PAIR — publish plus unpublish, which the
   * host validates at load.
   *
   * Not `supervise`: `tailscale serve --bg` hands the proxy to the daemon,
   * which already survives this server restarting, so a child process for the
   * host to babysit would be a second thing that can die. Not `guard`: a
   * tailnet is a private network of invited machines (the manifest says
   * `exposure: "private"`), so there is no front-door assertion to verify —
   * that is the shape of a public gateway. Not `settings`: everything this
   * needs is either on the machine or in the tailnet's own admin console.
   */
  capabilities: (): PluginCapability[] => ["publish"],

  async status(ctx: NetworkContext): Promise<NetworkStatus> {
    return (await readNetwork(host, ctx)).status;
  },

  async join(input: JoinInput): Promise<JoinOutcome> {
    return joinTailnet(host, input);
  },

  async leave(): Promise<void> {
    return leaveTailnet(host);
  },

  async publish(ctx: NetworkContext): Promise<PublishOutcome | PublishRefusal> {
    return publishServer(host, ctx);
  },

  async unpublish(): Promise<void> {
    return unpublishServer(host);
  },
});

export default createPlugin;
export { manifest } from "./manifest.js";
