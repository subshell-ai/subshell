import type {
  JoinInput,
  JoinOutcome,
  NetworkContext,
  NetworkPlugin,
  NetworkPluginFactory,
  NetworkStatus,
  PluginCapability,
  PluginHost,
  PresetValidationIssue,
  PublishOutcome,
  PublishRefusal,
  RequestGuardSpec,
  SettingsField,
  SupervisedProcessSpec,
} from "@subshell-ai/plugin-api";
import { readSettings, resolveBinary, TOKEN_SECRET } from "./cli.js";
import { joinTunnel } from "./join.js";
import { leaveTunnel, publishTunnel, tunnelProcessSpec, unpublishTunnel } from "./publish.js";
import { tunnelSettingsFields, validateTunnelSettings } from "./settings.js";
import { readNetwork } from "./status.js";

/**
 * Built-in: Cloudflare Tunnel — publish this server on a hostname you own,
 * behind Cloudflare Access.
 *
 * The first real user of `supervise` and `guard`, both of which phase 1
 * shipped declared-but-unused (spec 2026-09-15 § 12, phase 2-3 § 6). What
 * that means in practice: this plugin manages NOTHING. It returns two
 * declarations — a `SupervisedProcessSpec` the host's supervisor spawns,
 * restarts and reaps, and a `RequestGuardSpec` the host's `onRequest` plugin
 * verifies every arriving assertion against — and the host's existing
 * ordering (§ 5.3: stop the process first, drop the guard last) is the whole
 * lifecycle. Phase 1 built that machinery for exactly this shape; this file
 * is its first exercise, which is also why everything below is declarations
 * rather than management.
 *
 * **`exposure: "public-with-gate"` is a posture inversion**, and the design
 * bounds it in three places this plugin is on one side of: the exposure is
 * manifest data rendered before the button; the publish refuses until the
 * vendor's own edge confirms an Access application covers the hostname (the
 * pre-flight in `preflight.ts`, failing closed — § 10.5's unmeasured shapes
 * make silence a refusal, never a pass); and the host verifies every
 * assertion itself, refusing on `Host` so no header-presence trick skips it.
 * Access is a front door, not a session: Subshell's own cookie still decides
 * who you are HERE.
 *
 * **The tunnel token never touches a command line.** It is stored write-only
 * (`host.secrets`, no `get` by design) and named, never held: the host reads
 * it at spawn into the child's `TUNNEL_TOKEN` environment. `ps` on this host
 * shows `cloudflared tunnel run --no-autoupdate` and no credential — the
 * exposure the mesh join-keys accept for one short command is refused here
 * for a long-running child, which is the difference the secrets store exists
 * for.
 *
 * Identity, exposure, the one server-runnable installer (§ 8: cloudflared
 * needs no root) and the Linux apt step live in this package's `subshell`
 * block as data, rendered before any of this code loads.
 *
 * `host` carries what this module cannot import. See `@subshell-ai/plugin-api`.
 */
const createPlugin: NetworkPluginFactory = (host: PluginHost): NetworkPlugin => ({
  /**
   * All four network capabilities, which is what makes this the full-contract
   * plugin: `publish` (the pair), `supervise` (the child it describes),
   * `guard` (the check its exposure requires) and `settings` (the four fields
   * a publish is built from). The loader validates the pairing both ways and
   * per type, so `capabilityMismatches` at load is what guarantees this list
   * matches the members below.
   */
  capabilities: (): PluginCapability[] => ["publish", "supervise", "guard", "settings"],

  async status(ctx: NetworkContext): Promise<NetworkStatus> {
    return readNetwork(host, ctx);
  },

  async join(input: JoinInput): Promise<JoinOutcome> {
    return joinTunnel(host, input);
  },

  async leave(): Promise<void> {
    return leaveTunnel(host);
  },

  async publish(ctx: NetworkContext): Promise<PublishOutcome | PublishRefusal> {
    return publishTunnel(host, ctx);
  },

  async unpublish(): Promise<void> {
    return unpublishTunnel(host);
  },

  /**
   * The child the host should be running while this publish stands — re-derived
   * at every boot, from the host's own ladder and the stored settings, never
   * remembered from a previous publish.
   *
   * ASYNC, and that is the contract's first real use, not a preference: the
   * spec demands an ABSOLUTE `command` resolved through the host's lookup
   * ladder, `findBinary` is async, and boot re-asks this member before
   * anything else has run — a plugin that had to cache the path from an
   * earlier `status()` call would arm nothing on a freshly restarted server,
   * which is exactly the § 5.5 guarantee ("a rotated credential or a changed
   * port takes effect on the next spawn") failing in the common case.
   *
   * Null is a real answer: no settings, no token, or no binary means there is
   * nothing to run, and the row says so through `status()` rather than
   * crash-looping a child.
   */
  async supervisedProcess(ctx: NetworkContext): Promise<SupervisedProcessSpec | null> {
    if (readSettings(ctx) === null) return null;
    if (!ctx.secrets.has(TOKEN_SECRET)) return null;
    const binary = await resolveBinary(host);
    if (!binary) return null;
    return tunnelProcessSpec(binary);
  },

  /**
   * The front-door check this exposure requires, derived only from settings —
   * synchronous, because every input is already in `ctx` and the host must
   * have the answer BEFORE the listener accepts its first request.
   *
   * Null when the settings do not describe a guard, and the host's rule is
   * then total: a `public-with-gate` plugin with no guard gets no process
   * (`resolve-guard.ts` → the single arming site in `prepare.ts` refuses it,
   * and the publish route refuses before arming). The plugin cannot publish
   * itself past that by describing a tunnel without a guard — the guard is
   * what makes the tunnel allowed.
   */
  requestGuard(ctx: NetworkContext): RequestGuardSpec | null {
    const settings = readSettings(ctx);
    if (settings === null) return null;
    return {
      kind: "cloudflare-access",
      hostname: settings.hostname,
      teamDomain: settings.teamDomain,
      aud: settings.aud,
    };
  },

  settingsFields: (): SettingsField[] => tunnelSettingsFields(),

  validateSettings: (values: Record<string, string>): PresetValidationIssue[] => validateTunnelSettings(values),
});

export default createPlugin;
export { manifest } from "./manifest.js";
