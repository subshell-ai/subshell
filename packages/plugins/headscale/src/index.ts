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
import { joinHeadscaleNetwork } from "./join.js";
import { leaveTailnet, publishServer, unpublishServer } from "./publish.js";
import { readNetwork } from "./status.js";

/**
 * Built-in: Headscale — a self-hosted tailnet this server can be reached over.
 *
 * The same `tailscale` client as the Tailscale plugin, pointed at a control
 * server the operator runs themselves; the difference is who holds the CA, and
 * everything that follows from it (spec 2026-09-15 § 8): http addresses with a
 * hint saying why, an interactive login that a machine's owner cannot finish
 * alone, and a publish that may simply not be offered by the CLI (UNMEASURED,
 * spec 2026-09-15 § 10.3 — the code tries and refuses honestly).
 *
 * **It describes; the host executes.** Every verb is one or two `host.run`
 * calls against the vendor CLI, exactly as the tailscale plugin's are; nothing
 * here spawns, writes, stores a credential or edits this server's
 * configuration. See the tailscale plugin's docblock for the full statement of
 * the rule — this file is its sibling, not its restatement.
 *
 * **One machine, one tailnet.** A host running BOTH plugins reads the SAME
 * daemon twice, and the plugin's status cannot tell after the fact which
 * control server the daemon belongs to — so exactly one of the two rows can be
 * true at a time. The rule belongs to the user and lives in this package's
 * README.md; the code deliberately does not police it.
 *
 * Identity, platforms, exposure, the privileged steps and the `controlUrl`
 * field's shape live in this package's package.json and the one field list
 * below, NOT in inherited bytes: this plugin reads its OWN manifest.
 *
 * `host` carries what this module cannot import. See `@subshell-ai/plugin-api`.
 */
const createPlugin: NetworkPluginFactory = (host: PluginHost): NetworkPlugin => ({
  /**
   * `publish` (the pair) and `settings` — the one network plugin besides
   * cloudflare-tunnel that needs configuration, because a control server URL
   * is not something a machine can guess. Not `supervise`: `tailscale serve
   * --bg` hands the proxy to the daemon, as in the tailscale plugin. Not
   * `guard`: a self-hosted tailnet is still a private network (the manifest
   * says `exposure: "private"`).
   */
  capabilities: (): PluginCapability[] => ["publish", "settings"],

  async status(ctx: NetworkContext): Promise<NetworkStatus> {
    return (await readNetwork(host, ctx)).status;
  },

  async join(input: JoinInput, ctx: NetworkContext): Promise<JoinOutcome> {
    return joinHeadscaleNetwork(host, input, ctx);
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

  /**
   * The one thing this plugin cannot discover: which control server to join.
   *
   * REQUIRED (§ 4), because the alternative — a bare `tailscale up` — is not
   * "unset" but WRONG, quietly enrolling the machine into Tailscale's SaaS.
   * The route answers a missing required field before the plugin's join runs
   * (`configurationRefusal`); {@link joinHeadscaleNetwork} refuses again
   * because the refusal is the plugin's own guarantee, not the route's favor.
   */
  settingsFields: (): SettingsField[] => [
    {
      key: "controlUrl",
      label: "Control server URL",
      type: "string",
      required: true,
      placeholder: "https://headscale.example.com",
    },
  ],

  /**
   * The settings form's named-field error, mirroring the netbird plugin's
   * check of its structurally identical `managementUrl`.
   *
   * This is comfort, not a gate: `--login-server <url>` is a separate argv
   * element, no shell ever sees it, and the CLI refuses a garbage URL with
   * its own words at join time. What those words are cannot be predicted —
   * a DNS miss, a TLS mismatch, a non-responding control server all read
   * differently — so an obviously-wrong value gets caught where the form
   * can point at the field instead of arriving minutes later inside a
   * join's error frame.
   */
  validateSettings: (values: Record<string, string>): PresetValidationIssue[] => {
    const url = values.controlUrl?.trim();
    if (url && !isDocsUrl(url)) {
      return [
        {
          field: "controlUrl",
          message: "The control server URL must be a full http(s) URL, e.g. https://headscale.example.com.",
        },
      ];
    }
    return [];
  },
});

export default createPlugin;
export { manifest } from "./manifest.js";
