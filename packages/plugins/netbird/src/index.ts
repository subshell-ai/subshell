import {
  isDocsUrl,
  type JoinInput,
  type JoinOutcome,
  type NetworkContext,
  type NetworkPlugin,
  type NetworkPluginFactory,
  type NetworkStatus,
  type PluginCapability,
  type PluginHost,
  type PresetValidationIssue,
  type PublishOutcome,
  type PublishRefusal,
  type SettingsField,
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
   * `publish` (the pair) and `settings`.
   *
   * Not `supervise`: there is no long-running child to babysit — NetBird's daemon
   * is a service the operator installed, not a process this plugin spawns. Not
   * `guard`: NetBird is a private network of enrolled machines (the manifest says
   * `exposure: "private"`), so there is no front-door assertion to verify. The
   * `settings` capability is because this plugin declares a `managementUrl` field
   * for self-hosted NetBird, which `capabilityMismatches` requires be paired with
   * the declaration.
   */
  capabilities: (): PluginCapability[] => ["publish", "settings"],

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

  /**
   * The one knob a self-hosted NetBird needs. Absent means the vendor's SaaS
   * management service, which is right for the hosted accounts most people use.
   */
  settingsFields: (): SettingsField[] => [
    {
      key: "managementUrl",
      label: "Management URL (self-hosted only)",
      description:
        "Leave blank for the hosted NetBird service. Set this only if you run your own NetBird management server.",
      type: "string",
      required: false,
      placeholder: "https://master.netbird.example.com",
    },
  ],

  /**
   * A management URL, when one is set, must be an http(s) origin.
   *
   * It rides into `netbird up --management-url=…` argv, and a value that is not a
   * URL would be rejected by NetBird seconds later with a network error that says
   * nothing about the field. Checking it here turns that into a named field error
   * on the settings form.
   */
  validateSettings: (values: Record<string, string>): PresetValidationIssue[] => {
    const url = values.managementUrl?.trim();
    if (url && !isDocsUrl(url)) {
      return [
        {
          field: "managementUrl",
          message: "The management URL must be a full http(s) URL, e.g. https://master.netbird.example.com.",
        },
      ];
    }
    return [];
  },
});

export default createPlugin;
export { manifest } from "./manifest.js";
