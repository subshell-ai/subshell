import {
  getNetworkPlugin,
  hostPlatform,
  type NetworkAddress,
  type NetworkContext,
  type NetworkPluginEntry,
  type PluginPlatform,
  type SupervisedProcessSpec,
} from "@internal/pane-runtime";
import { applyConfig } from "@/commands/configure.js";
import { configEnvAppliedKeys, resolveConfig, serverConfigDir } from "@/config-env.js";
import { DEFAULT_TRUSTED_ORIGINS, IS_TEST, SERVER_PORT } from "@/constants.js";
import { type OwnedGuard, setAccessGuards } from "@/plugins/access-guard.plugin.js";
import { type AuditEventInput, audit } from "@/services/audit.js";
import { networkContext, readNetworkState, writeNetworkState } from "@/services/network/state.js";
import { armProcess } from "@/services/network/supervisor.js";
import { enabledNetworkPlugins } from "@/services/nodes/local-plugins.js";
import { settingSource } from "@/services/server-deployment.js";
import { getLogger } from "@/utils/logger.js";

/**
 * Bringing this instance's published networks back up at boot.
 *
 * Split in two, and the split is an ORDERING rather than a tidy-up:
 *
 * - **Guards go in before the listener accepts anything.** A tunnel that
 *   survived the restart is already resolvable, so the first request over it
 *   can arrive in the same millisecond the port opens. A guard installed after
 *   that is a guard that missed requests.
 * - **Processes go up after it.** A tunnel proxies to this port, so starting
 *   one before the server answers publishes a machine that returns connection
 *   refused — worse than being briefly absent, because it is briefly WRONG.
 *
 * Everything here is best-effort and logged. A network plugin must never be
 * why a serviceable instance fails to boot: the plugin is third-party code, a
 * vendor daemon may be missing, and an operator locked out of their own
 * dashboard can fix neither. The page reports what did not come up.
 */

/** The seams a test replaces: the plugin set, the registry, this host's OS, and every write. */
export interface NetworkPrepareDeps {
  /** The enabled network plugins. Production: the instance store minus what an admin disabled. */
  listPlugins(): Promise<{ id: string }[]>;
  /** Resolve one loaded plugin. Production: the pane-runtime registry. */
  getPlugin(id: string): NetworkPluginEntry | undefined;
  /** This host's OS in the manifest's vocabulary. */
  platform(): PluginPlatform;
  /** Hand a child to the supervisor. */
  arm(pluginId: string, spec: SupervisedProcessSpec): void;
  /** Install the complete guard set. */
  setGuards(guards: OwnedGuard[]): void;
  /** Record an event. */
  audit(event: AuditEventInput): Promise<void>;
  /**
   * Union a republish's addresses into `TRUSTED_ORIGINS`.
   *
   * Injected rather than called directly because the production writer rewrites
   * the config home's `config.env` — a suite that reached it would edit the
   * developer's own instance configuration, which no assertion is worth.
   */
  trustOrigins(pluginId: string, addresses: NetworkAddress[]): void;
}

const defaultDeps: NetworkPrepareDeps = {
  listPlugins: enabledNetworkPlugins,
  getPlugin: getNetworkPlugin,
  platform: hostPlatform,
  arm: armProcess,
  setGuards: setAccessGuards,
  audit,
  trustOrigins: writeTrustedOrigins,
};

let depsOverride: NetworkPrepareDeps | undefined;

/**
 * Test seam: swap the plugin set, the registry and every write. Refuses
 * outside the suite — a mis-wired production import must not be able to
 * redirect what boot arms, guards or writes.
 * @internal
 */
export function setNetworkPrepareDepsForTests(deps: NetworkPrepareDeps | null): void {
  if (!IS_TEST) throw new Error("setNetworkPrepareDepsForTests is a test-only seam");
  depsOverride = deps ?? undefined;
}

function deps(): NetworkPrepareDeps {
  return depsOverride ?? defaultDeps;
}

/** One published plugin that may act on this host, with the context it is called through. */
interface Eligible {
  id: string;
  entry: NetworkPluginEntry;
  ctx: NetworkContext;
  /** The `SERVER_PORT` the recorded publish was made against. */
  publishedPort: number | null;
}

/**
 * Every enabled network plugin that is published, loadable, and runnable here.
 *
 * All three gates are structural rather than defensive. `published` is the
 * admin's decision and the only thing that makes any of this the host's
 * business. A plugin that will not load has nothing to be asked. And the
 * PLATFORM gate is manifest DATA read without loading plugin code — a data
 * directory carried from a mac to a Linux box holds a publish for a plugin
 * that can drive nothing here, and asking it anyway would be asking a question
 * the manifest already answered.
 */
async function eligible(): Promise<Eligible[]> {
  const out: Eligible[] = [];
  for (const row of await deps().listPlugins()) {
    const state = await readNetworkState(row.id);
    if (!state.published) continue;
    const entry = deps().getPlugin(row.id);
    if (!entry) {
      getLogger().warn(`network plugin "${row.id}" is published but will not load; nothing was started for it`);
      continue;
    }
    if (!entry.manifest.network?.platforms.includes(deps().platform())) {
      getLogger().warn(
        `network plugin "${row.id}" is published but does not run on ${deps().platform()}; nothing was started for it`,
      );
      continue;
    }
    out.push({ id: row.id, entry, ctx: await networkContext(row.id, entry), publishedPort: state.port });
  }
  return out;
}

/**
 * Installs every published plugin's front-door check. Call BEFORE the listener.
 *
 * The whole set goes in with ONE call rather than a plugin at a time, so the
 * guards the server runs with are always complete: an installer that appended
 * would leave a moment in which one published network's traffic was checked
 * and another's was not, and no ordering of the appends removes it.
 */
export async function prepareNetworkGuards(): Promise<void> {
  try {
    const guards: OwnedGuard[] = [];
    unguarded.clear();
    for (const { id, entry, ctx } of await eligible()) {
      if (!entry.plugin.requestGuard) continue;
      try {
        const guard = entry.plugin.requestGuard(ctx);
        if (guard) guards.push({ pluginId: id, spec: guard });
        else if (needsGuard(entry)) unguarded.add(id);
      } catch (err) {
        // The publish is not undone over this, but the PROCESS half must know:
        // a `public-with-gate` network whose guard could not be built must not
        // then have its tunnel started. Those are different methods over
        // different data — a Cloudflare-shaped plugin needs a hostname and an
        // audience for its guard and only a token for its process — so one
        // failing says nothing about the other, and an admin clearing a single
        // settings field is enough to produce exactly this.
        if (needsGuard(entry)) unguarded.add(id);
        getLogger().withError(err).warn(`network plugin "${id}" failed to describe its request guard`);
      }
    }
    deps().setGuards(guards);
    if (guards.length > 0) getLogger().info(`networks: ${guards.length} request guard(s) installed`);
  } catch (err) {
    getLogger().withError(err).warn("could not prepare network request guards; none are installed");
  }
}

/**
 * Reconciles a changed port, then arms every published plugin's process. Call
 * AFTER the listener is up.
 */
export async function prepareNetworkProcesses(): Promise<void> {
  try {
    let republished = false;
    const rows = await eligible();
    // The reconcile pass runs FIRST and completely, so the re-ask below lands
    // before any tunnel is armed. Re-installing the guards after the arming
    // loop inverted this file's whole ordering rule on the port-change path:
    // for one moment a republished network's tunnel was up against the OLD
    // guard set.
    const reconciled = new Set<string>();
    for (const row of rows) {
      if (row.publishedPort !== null && row.publishedPort !== SERVER_PORT && (await reconcilePort(row))) {
        republished = true;
        reconciled.add(row.id);
      }
    }
    // A republish may have produced a different guard — a new hostname, a new
    // Access application. Cheaper to re-ask everyone than to reason about
    // whose changed, and this runs at most once per boot.
    if (republished) await prepareNetworkGuards();
    for (const row of rows) {
      // A reconcile already armed the process its OWN republish described.
      // Arming again from `supervisedProcess(ctx)` would stop that child and
      // spawn a replacement, so the outcome's process never won — and the two
      // can legitimately differ, which is the only reason `PublishOutcome`
      // carries a process at all.
      if (!reconciled.has(row.id)) armFrom(row);
    }
  } catch (err) {
    getLogger().withError(err).warn("could not start network plugin processes; published networks may be down");
  }
}

/**
 * Ids whose guard could not be built on the last {@link prepareNetworkGuards}
 * pass, and which declare an exposure that may not run without one.
 *
 * Module state because the two halves are deliberately separated in time —
 * guards before the listener, processes after it — and the second half has to
 * know what the first could not do.
 */
const unguarded = new Set<string>();

/**
 * Whether this plugin's exposure makes a request guard mandatory.
 *
 * Manifest data, read without loading plugin code: `public-with-gate` means
 * publishing reaches the open internet with an identity check in front. The
 * check IS the perimeter there, so a tunnel without one is the whole risk the
 * exposure label exists to bound.
 */
function needsGuard(entry: NetworkPluginEntry): boolean {
  return entry.manifest.network?.exposure === "public-with-gate";
}

/** Arms the child a plugin asks for, when it asks for one. */
function armFrom({ id, entry, ctx }: Eligible): void {
  if (!entry.plugin.supervisedProcess) return;
  // The refusal the guard half could not make for itself. A publish that
  // reaches the public internet is allowed exactly one enforcement point, and
  // starting its tunnel while that point is missing is worse than the network
  // simply being down: the server is reachable and unchecked.
  if (needsGuard(entry) && unguarded.has(id)) {
    getLogger().warn(
      `network plugin "${id}" publishes to the public internet and has no request guard; its process is NOT being started`,
    );
    return;
  }
  try {
    const spec = entry.plugin.supervisedProcess(ctx);
    if (spec) deps().arm(id, spec);
  } catch (err) {
    getLogger().withError(err).warn(`network plugin "${id}" failed to describe its supervised process`);
  }
}

/**
 * Re-publishes a network whose recorded port is not the port this server now
 * listens on.
 *
 * This is the one thing a plugin cannot do for itself. A publish is a
 * statement about a PORT — a tunnel points at one, an address names one — and
 * a plugin is deliberately given no memory of the port it published against,
 * so only the host can notice that an admin changed `SERVER_PORT` and
 * restarted. Left alone, the symptom is a tunnel that resolves and refuses
 * every connection, with nothing anywhere saying why.
 *
 * A refusal or a throw leaves `published` TRUE and changes nothing else. The
 * publish is still the admin's standing decision; what failed is this host's
 * attempt to honour it, and the plugin's own `status()` is what tells the page
 * so. Unpublishing here would silently discard an operator's configuration
 * because a daemon was slow to start.
 * @returns true when the republish produced new addresses
 */
async function reconcilePort({ id, entry, ctx, publishedPort }: Eligible): Promise<boolean> {
  if (!entry.plugin.publish) {
    getLogger().warn(
      `network plugin "${id}" was published on port ${publishedPort} and this server now listens on ${SERVER_PORT}, but it cannot re-publish; its addresses may be stale`,
    );
    return false;
  }
  getLogger().info(
    `networks: re-publishing "${id}" — published on port ${publishedPort}, this server is on ${SERVER_PORT}`,
  );
  let outcome: Awaited<ReturnType<NonNullable<NetworkPluginEntry["plugin"]["publish"]>>>;
  try {
    outcome = await entry.plugin.publish(ctx);
  } catch (err) {
    getLogger()
      .withError(err)
      .warn(
        `network plugin "${id}" threw while re-publishing on port ${SERVER_PORT}; it stays published and unreachable`,
      );
    return false;
  }
  if ("refused" in outcome) {
    getLogger().warn(`network plugin "${id}" refused to re-publish on port ${SERVER_PORT}: ${outcome.refused.text}`);
    return false;
  }

  await writeNetworkState(id, {
    port: SERVER_PORT,
    addresses: outcome.addresses,
    publishedAt: new Date().toISOString(),
  });
  // The plugin may hand back a NEW process description with the outcome, and
  // arming from that is what makes the new tunnel the one that runs — rather
  // than whatever `supervisedProcess` would describe a moment later.
  if (outcome.process) deps().arm(id, outcome.process);
  deps().trustOrigins(id, outcome.addresses);

  // Actor null: nobody asked for this, the boot noticed. The pair with the
  // admin-actored `network.publish` row that recorded the original decision
  // reads as "who asked" and "what the host did about it later".
  await deps().audit({
    actorUserId: null,
    action: "network.publish",
    targetType: "plugin",
    targetId: id,
    metadataJson: JSON.stringify({
      reason: "port-change",
      from: publishedPort,
      to: SERVER_PORT,
      addresses: outcome.addresses,
    }),
  });
  return true;
}

/**
 * Adds any new address origin to `TRUSTED_ORIGINS` in config.env.
 *
 * A publish invites a browser to a NAME this instance has never heard of, and
 * the allowlist is static by design — deriving it from the request's own Host
 * is the DNS-rebinding hole it exists to close (docs/security.md §8). So the
 * new origin has to be written down, and the writer is `applyConfig`: the same
 * validated, canonicalizing, wildcard-refusing writer the CLI and the
 * Addresses card use, rather than a second one that would make those
 * guarantees true only of the surfaces that remembered them.
 *
 * Three rules, each of which was a bug in the obvious version:
 *
 * - **Only ever a union.** Removing an origin here would take away an address
 *   an operator typed by hand because a plugin's answer changed.
 * - **An absent key starts from the BUILT-IN default, not from empty.** That
 *   default is non-empty (the dev Vite origins) and the file beats `.env` in
 *   the precedence ladder, so writing only the new origin would silently strip
 *   them on a developer's own machine.
 * - **A key the environment owns is not written.** The same refusal
 *   `PATCH /api/admin/server/config` makes: a file write the next boot would
 *   mask is a success report for a change that never happens.
 *
 * It takes effect at the next RESTART, because this process derived its own
 * allowlist at boot. The line says so rather than reporting a success an
 * operator would test immediately and disbelieve.
 */
function writeTrustedOrigins(pluginId: string, addresses: NetworkAddress[]): void {
  const wanted: string[] = [];
  for (const address of addresses) {
    try {
      wanted.push(new URL(address.url).origin);
    } catch {
      getLogger().warn(`network plugin "${pluginId}" reported an address that is not a URL: ${address.url}`);
    }
  }
  if (wanted.length === 0) return;

  let values: Record<string, string>;
  try {
    values = resolveConfig().values;
  } catch (err) {
    getLogger()
      .withError(err)
      .warn(`could not read config.env, so "${pluginId}"'s addresses were not added to TRUSTED_ORIGINS`);
    return;
  }
  if (settingSource("TRUSTED_ORIGINS", process.env, configEnvAppliedKeys(), values) === "process env") {
    getLogger().warn(
      `TRUSTED_ORIGINS is set in this server's environment, so "${pluginId}"'s addresses were not added; add ${wanted.join(", ")} where the server is started`,
    );
    return;
  }

  const base = (values.TRUSTED_ORIGINS ?? DEFAULT_TRUSTED_ORIGINS)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const added = wanted.filter((origin) => !base.includes(origin));
  if (added.length === 0) return;

  const result = applyConfig({ trustedOrigins: [...base, ...added].join(",") }, serverConfigDir());
  if (!result.ok) {
    getLogger().warn(
      `could not add ${added.join(", ")} to TRUSTED_ORIGINS: ${result.kind === "unreadable" ? result.reason : `${result.key}: ${result.reason}`}`,
    );
    return;
  }
  getLogger().info(`networks: added ${added.join(", ")} to TRUSTED_ORIGINS; trusted from the next restart`);
}
