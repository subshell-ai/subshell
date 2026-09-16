import {
  getNetworkPlugin,
  hostPlatform,
  type NetworkAddress,
  type NetworkContext,
  type NetworkPluginEntry,
  type PluginPlatform,
  type PublishOutcome,
  type RequestGuardSpec,
  type SupervisedProcessSpec,
} from "@internal/pane-runtime";
import { applyConfig } from "@/commands/configure.js";
import { configEnvAppliedKeys, resolveConfig, serverConfigDir } from "@/config-env.js";
import { DEFAULT_TRUSTED_ORIGINS, IS_TEST, SERVER_PORT } from "@/constants.js";
import { type OwnedGuard, setAccessGuards } from "@/plugins/access-guard.plugin.js";
import { type AuditEventInput, audit } from "@/services/audit.js";
import { resolveNetworkGuard } from "@/services/network/resolve-guard.js";
import { networkContext, readNetworkState, writeNetworkState } from "@/services/network/state.js";
import { armProcess, processState } from "@/services/network/supervisor.js";
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
  /**
   * Whether the supervisor currently holds an entry for this plugin.
   *
   * "An entry", not "a running child": for a plugin whose daemon IS the
   * supervised child, the supervisor is the health line — a `status()` that
   * cannot see it must not out-shout it at boot. Armed-but-not-yet-ready and
   * armed-and-parked both belong to the supervisor, whose own last lines
   * render on the row.
   */
  childArmed(pluginId: string): boolean;
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
  /**
   * Say something an operator will read later.
   *
   * A seam only so a test can assert the boot health report is MADE. Every
   * other warning in this file is incidental to whatever failed; that one is
   * the whole point of the pass, so it needs pinning rather than trusting.
   */
  warn(message: string): void;
}

const defaultDeps: NetworkPrepareDeps = {
  listPlugins: enabledNetworkPlugins,
  getPlugin: getNetworkPlugin,
  platform: hostPlatform,
  arm: armProcess,
  childArmed: (pluginId) => processState(pluginId) !== null,
  setGuards: setAccessGuards,
  audit,
  trustOrigins: writeTrustedOrigins,
  warn: (message) => getLogger().warn(message),
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
 * One eligible row with its guard question already answered.
 *
 * **The guard fact travels WITH the row**, rather than living in a module Set
 * the arming sites are each expected to remember to consult. It used to, and
 * that shape produced three separate findings: a plugin whose guard threw, one
 * whose guard was null, and one with no guard member at all were three
 * different holes in the same rule, and the port-change path armed without
 * consulting the Set at all — so a `public-with-gate` tunnel started with zero
 * guards installed even when the Set correctly held its id.
 *
 * A memo read at one arming site out of three means a NEW arming site is
 * unguarded by default. A field on the value in hand means the compiler asks.
 */
interface Prepared extends Eligible {
  /** What this plugin declares right now, or null for any reason at all. */
  guard: RequestGuardSpec | null;
  /**
   * True when this exposure requires a guard and none was produced.
   *
   * ANY reason: the member is absent, it returned null, it threw. They are one
   * rule — for an exposure whose guard IS the perimeter, no guard means no
   * process — and separating them is what let two of the three through.
   */
  refuseProcess: boolean;
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
export async function prepareNetworkGuards(): Promise<Prepared[]> {
  try {
    const prepared = (await eligible()).map((row) => resolveGuard(row));
    const guards = prepared.flatMap((row) => (row.guard ? [{ pluginId: row.id, spec: row.guard }] : []));
    deps().setGuards(guards);
    if (guards.length > 0) getLogger().info(`networks: ${guards.length} request guard(s) installed`);
    return prepared;
  } catch (err) {
    getLogger().withError(err).warn("could not prepare network request guards; none are installed");
    return [];
  }
}

/** One eligible row with its guard question answered, by the shared resolver. */
function resolveGuard(row: Eligible): Prepared {
  const { guard, refused } = resolveNetworkGuard(row.entry, row.ctx);
  return { ...row, guard, refuseProcess: refused };
}

/**
 * Reconciles a changed port, then arms every published plugin's process. Call
 * AFTER the listener is up.
 *
 * Takes what {@link prepareNetworkGuards} resolved, so the two halves cannot
 * disagree about which plugins may run. Passing nothing RE-DERIVES rather than
 * reading a memo — that is what makes calling this alone correct instead of
 * merely unsupported, and it is what a later re-arm path will want.
 * @param prepared - the rows the guard pass resolved; omit to re-derive
 */
export async function prepareNetworkProcesses(prepared?: Prepared[]): Promise<void> {
  try {
    let republished = false;
    const rows = prepared ?? (await eligible()).map((row) => resolveGuard(row));
    // THE RECONCILE PASS RUNS FIRST AND COMPLETELY, AND ARMS NOTHING. It used
    // to arm `outcome.process` itself, which put a third arming site outside
    // the refusal — and worse, it then made the arming loop SKIP that row, so
    // a `public-with-gate` tunnel started with zero guards installed even when
    // the refusal correctly named it. One loop arms now, and it is the loop
    // that checks.
    const republishedProcess = new Map<string, SupervisedProcessSpec>();
    for (const row of rows) {
      if (row.publishedPort === null || row.publishedPort === SERVER_PORT) continue;
      const outcome = await reconcilePort(row);
      if (!outcome) continue;
      republished = true;
      // The plugin may hand back a NEW process with the outcome, and running
      // that one rather than whatever `supervisedProcess` says a moment later
      // is the only reason `PublishOutcome` carries a process at all.
      if (outcome.process) republishedProcess.set(row.id, outcome.process);
    }
    // A republish may have produced a different guard — a new hostname, a new
    // Access application — so the set is re-asked BEFORE anything is armed.
    // Re-asking afterwards left the republished row's own tunnel up against
    // the pre-republish guard set, which is the ordering this file exists to
    // keep.
    const armable = republished ? await prepareNetworkGuards() : rows;
    for (const row of armable) {
      await armFrom(row, republishedProcess.get(row.id));
    }
    // ...and then ask each of them whether it is actually carrying traffic.
    for (const row of armable) {
      if (!republishedProcess.has(row.id)) await reportIfDown(row);
    }
  } catch (err) {
    getLogger().withError(err).warn("could not start network plugin processes; published networks may be down");
  }
}

/**
 * Says so, once, when a published network is not actually up.
 *
 * The realistic failure and the one nothing else catches: the machine
 * rebooted, this server came back, and the vendor's daemon did not. The
 * addresses an operator published still resolve, nothing answers at them, and
 * until this the first anyone heard of it was opening the Networking page —
 * which is the one place a person goes only when they already suspect
 * something.
 *
 * A read at BOOT rather than a timer. Detection in this codebase is "never a
 * timer, never a sweep" (`services/nodes/inventory.ts`), and a background poll
 * would spawn a vendor CLI forever for every published network — the same cost
 * the page's own cadence was just narrowed to avoid. Once per boot per
 * published plugin is nearly free, and a reboot is exactly when this breaks.
 *
 * It reports rather than repairs. `joined` means the machine is on the network
 * and not serving, which a re-publish would fix — but a publish is an admin's
 * standing decision about an address, and re-making it unattended is how a
 * server starts publishing somewhere the operator had deliberately stopped.
 * The line goes to the server's own log, which an admin reads over HTTP.
 */
async function reportIfDown({ id, entry, ctx }: Eligible): Promise<void> {
  try {
    // A supervised plugin's daemon IS the host's child, and `status()` cannot
    // see it — honest answers top out at `joined` no matter how healthy the
    // tunnel is. When the supervisor holds an entry for this plugin, the
    // child's own state is the health line and it already renders on the row
    // (running, parked, last exit, last lines); warning "NOT publishing,
    // re-publish it" at boot would send an admin to press a button that
    // changes nothing, every boot, about a tunnel that is fine. When NOTHING
    // is armed — the binary gone under a restored data dir, the settings
    // unreadable — the warning below is the honest last word.
    if (entry.plugin.supervisedProcess && deps().childArmed(id)) return;
    const status = await entry.plugin.status(ctx);
    if (status.state === "published") return;
    const because = status.hints[0]?.text ?? `it reports "${status.state}"`;
    deps().warn(
      status.state === "joined"
        ? `network "${entry.manifest.name}" is on the network but is NOT publishing this server; the addresses it was published at answer nothing. Re-publish it under Settings → Networking.`
        : `network "${entry.manifest.name}" is published but not reachable: ${because}`,
    );
  } catch (err) {
    // A plugin that throws here has already been reported by whatever else
    // asked it; this is a diagnosis, and a diagnosis that fails is not a
    // reason to interfere with a boot that has otherwise succeeded.
    getLogger().withError(err).warn(`could not check whether network "${id}" is up`);
  }
}

/**
 * Arms the child for one row: the republish's own, or the one the plugin
 * describes now.
 *
 * THE ONLY place this pass arms anything, which is what makes the refusal
 * below total. It reads `refuseProcess` off the row in its hand rather than
 * consulting a memo, so a site that forgot to check cannot exist: there is one
 * site, and the field is on its argument.
 * @param row - the eligible plugin, with its guard question already answered
 * @param republished - the process a port-change republish just described, if any
 */
async function armFrom(row: Prepared, republished?: SupervisedProcessSpec): Promise<void> {
  const { id, entry, ctx, refuseProcess } = row;
  // The refusal, applied to BOTH sources of a process. A publish that reaches
  // the public internet is allowed exactly one enforcement point, and starting
  // its tunnel while that point is missing is worse than the network being
  // down: the server is reachable and unchecked.
  if (refuseProcess) {
    getLogger().warn(
      `network plugin "${id}" publishes to the public internet and has no request guard; its process is NOT being started`,
    );
    return;
  }
  if (republished) {
    deps().arm(id, republished);
    return;
  }
  if (!entry.plugin.supervisedProcess) return;
  try {
    // AWAITED, and that await is the whole point: the member may return a
    // promise because its absolute `command` comes from the host's async
    // `findBinary` ladder, and a boot has no earlier call whose cache a
    // synchronous member could have been fed by. Handing `armProcess` a
    // Promise as if it were a spec would arm a crash loop against a value
    // that is not a command.
    const spec = await entry.plugin.supervisedProcess(ctx);
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
async function reconcilePort({ id, entry, ctx, publishedPort }: Eligible): Promise<PublishOutcome | null> {
  if (!entry.plugin.publish) {
    getLogger().warn(
      `network plugin "${id}" was published on port ${publishedPort} and this server now listens on ${SERVER_PORT}, but it cannot re-publish; its addresses may be stale`,
    );
    return null;
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
    return null;
  }
  if ("refused" in outcome) {
    getLogger().warn(`network plugin "${id}" refused to re-publish on port ${SERVER_PORT}: ${outcome.refused.text}`);
    return null;
  }

  await writeNetworkState(id, {
    port: SERVER_PORT,
    addresses: outcome.addresses,
    publishedAt: new Date().toISOString(),
  });
  // NOT armed here. This used to call `deps().arm` directly, which made the
  // reconcile a third arming site outside the guard refusal — and then made
  // the arming loop skip this row, so the refusal could not reach it even when
  // it correctly named the plugin. The outcome goes back to the one loop that
  // arms and checks.
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
  return outcome;
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
