import { BackendErrorCodes } from "@internal/backend-errors";
import {
  allNetworkPlugins,
  hostPlatform,
  isDocsUrl,
  loginPathEntries,
  type NetworkContext,
  type NetworkManifest,
  type NetworkPluginEntry,
  type NetworkStatus,
  type PluginPlatform,
} from "@internal/pane-runtime";
import type { PluginReportWire } from "@internal/subshell-protocol";
import { ForbiddenError } from "@/api/auth-guard.js";
import { resolveSetupActor } from "@/api/setup.route.js";
import { type ApplyConfigInput, type ApplyConfigResult, applyConfig } from "@/commands/configure.js";
import { configEnvAppliedKeys, resolveConfig, serverConfigDir } from "@/config-env.js";
import { DEFAULT_TRUSTED_ORIGINS, IS_TEST, SERVER_PORT } from "@/constants.js";
import { db } from "@/db/index.js";
import { PluginStateRepository } from "@/db/repositories/plugin-state.repository.js";
import { resolveCookieSession } from "@/lib/session-cookie.js";
import { type AgentInstallResult, runInstaller } from "@/services/agent-install.service.js";
import { audit } from "@/services/audit.js";
import { observeNetworkStatus } from "@/services/network/origins.js";
import { networkContext } from "@/services/network/state.js";
import { localPluginReports } from "@/services/nodes/local-plugins.js";
import { settingSource } from "@/services/server-deployment.js";
import { getLogger } from "@/utils/logger.js";

/**
 * Everything the six `/api/network` routes share (spec 2026-09-15 § 5.1): the
 * gate, the refusal table, the in-flight lock, the status memo and the two
 * config writes — the union a publish adds, the subtraction an unpublish takes back.
 *
 * Its own module for the reason `nodes/node-gate.ts` is: six handlers deciding
 * "may this caller act, and is this plugin in a state to be acted on" is six
 * chances to answer differently, and the answers here are what keep a
 * third-party plugin's code from running on an unsupported platform, twice at
 * once, or against a daemon that is not there.
 */

/** A refusal decided BEFORE anything runs. See {@link refuseNetworkAct}. */
export interface NetworkRefusal {
  /** The HTTP status. Narrow on purpose: the routes' `response` maps name exactly these. */
  status: 400 | 404 | 409;
  /** The wire code. */
  code: BackendErrorCodes;
  /** The sentence an admin acts on. */
  message: string;
}

/** A network plugin this process resolved, with everything a route needs about it. */
export interface ResolvedNetwork {
  /** The loaded plugin and its manifest. */
  entry: NetworkPluginEntry;
  /** `manifest.network`, which a `network` plugin always carries. */
  manifest: NetworkManifest;
  /** The installed-store report for it (version, and `broken` when it will not load). */
  report: PluginReportWire;
}

/**
 * The seam the route tests inject through.
 *
 * It covers exactly the things a suite must not do for real: resolve the
 * machine's actual plugin store, ask this host's real platform, and rewrite
 * `~/.config/subshell-server/config.env`. The state file, the supervisor and
 * the unpublish sequence are NOT here — each carries its own seam, and the
 * state file already lives under the suite's temp data dir.
 */
export interface NetworkDeps {
  /** Every network plugin this process can LOAD, manifest included. Production: `allNetworkPlugins()`. */
  plugins: () => NetworkPluginEntry[];
  /** Installed network plugin reports, whatever their enable flag. */
  installed: () => Promise<PluginReportWire[]>;
  /** The enabled subset, through the sanctioned accessor — the ACT gate reads this one. */
  enabled: () => Promise<PluginReportWire[]>;
  /** This host's platform. Production: `hostPlatform()`. */
  platform: () => PluginPlatform;
  /** The config.env writer. Production: `applyConfig` into `serverConfigDir()`. */
  applyConfig: (input: ApplyConfigInput) => ApplyConfigResult;
  /** config.env's stored values, for the origin union and the source attribution. */
  configValues: () => Record<string, string>;
  /** Keys config.env actually applied at boot. Production: `configEnvAppliedKeys()`. */
  appliedKeys: () => ReadonlySet<string>;
  /** The environment the source attribution is computed against. */
  env: () => NodeJS.ProcessEnv;
  /** The port this server listens on — the publish target. Production: `SERVER_PORT`. */
  port: () => number;
  /**
   * Runs the vendor's own installer and reports it, streaming its output.
   *
   * A seam rather than a direct call so a suite never spawns a package
   * manager, and so a test can assert the ARGV — which is the part that
   * matters: the command comes from the plugin's manifest and the request
   * body contributes nothing to it. Production wraps `runInstaller` with this
   * host's deadline and login-shell PATH.
   */
  runInstall: (argv: readonly string[], onLine: (line: string) => void) => Promise<AgentInstallResult>;
}

/**
 * Generous on purpose, and the same as the agent and tmux installers': a
 * package manager on a cold cache takes minutes, and this runs unattended
 * with no way to extend it interactively.
 */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

const defaultDeps: NetworkDeps = {
  plugins: () => allNetworkPlugins(),
  installed: async () => (await localPluginReports()).filter((r) => r.type === "network"),
  // `enabledNetworkPlugins` re-reads the same two sources; this is that
  // function's body rather than a call to it only because the list route
  // needs both sets from ONE pair of reads, and two calls would do four.
  enabled: async () => {
    const [state, reports] = await Promise.all([new PluginStateRepository(db).stateByPluginId(), localPluginReports()]);
    return reports.filter((r) => r.type === "network" && state.get(r.id) !== false);
  },
  platform: () => hostPlatform(),
  applyConfig: (input) => applyConfig(input, serverConfigDir()),
  configValues: () => resolveConfig().values,
  appliedKeys: () => configEnvAppliedKeys(),
  env: () => process.env,
  port: () => SERVER_PORT,
  runInstall: (argv, onLine) =>
    runInstaller(argv, { timeoutMs: INSTALL_TIMEOUT_MS, extraPath: loginPathEntries, onLine }),
};

let depsOverride: NetworkDeps | undefined;

/** The deps in force. Exported so each route module reads the same override. */
export function networkDeps(): NetworkDeps {
  return depsOverride ?? defaultDeps;
}

/**
 * Test seam. Refuses outside the suite, the `setTmuxInstallDepsForTests`
 * pattern: a production import able to swap these could redirect which plugin
 * code runs and which file the config writer rewrites.
 * @internal
 */
export function setNetworkDepsForTests(deps: NetworkDeps | null): void {
  if (!IS_TEST) throw new Error("setNetworkDepsForTests is a test-only seam");
  depsOverride = deps ?? undefined;
  statusMemo.clear();
  inFlight.clear();
}

/**
 * The gate on EVERY route here: an admin COOKIE session, with no no-users
 * carve-out.
 *
 * `resolveSetupActor` rather than `requireAdmin` for the same reason the two
 * installer routes use it — it classifies the credential without mounting a
 * guard, so one call answers "anonymous" (401) and "a machine credential or a
 * plain user" (403) alike. Bearer keys are refused even when the key's owner
 * is an admin: these routes join this machine to a network and rewrite its
 * config, which has no machine consumer.
 *
 * The rest of `/api/setup` is public while the instance has no users, because
 * the wizard runs before an admin exists. This is deliberately NOT — the
 * wizard's network step sits after Create Your Account for exactly this
 * reason.
 */
export async function requireNetworkAdmin(request: Request): Promise<void> {
  if ((await resolveSetupActor(request)) !== "admin") throw new ForbiddenError();
}

/**
 * One plugin id → the plugin, or the refusal that names why not.
 *
 * Four conditions collapse into ONE 404 on purpose: an id nothing knows, an id
 * that is a harness rather than a network, a network plugin whose bytes are
 * not installed, and one an admin disabled. All four mean "there is nothing at
 * this path for you to act on", and distinguishing them would let a caller
 * enumerate what an instance holds but does not offer.
 */
export async function resolveNetwork(id: string): Promise<ResolvedNetwork | NetworkRefusal> {
  const deps = networkDeps();
  const notFound: NetworkRefusal = {
    status: 404,
    code: BackendErrorCodes.NOT_FOUND_ERROR,
    message: `"${id}" is not a network this instance offers`,
  };
  // The ENABLED set, through the accessor whose whole job is that filter — a
  // disabled plugin must not be actable, and asking the installed set here
  // would make this route the weaker of two doors onto one plugin.
  const report = (await deps.enabled()).find((r) => r.id === id);
  if (!report) return notFound;
  const entry = deps.plugins().find((e) => e.manifest.id === id);
  // Installed but not loadable (a broken plugin). It keeps its row on
  // `/api/plugins`, carrying the loader's message; there is nothing here to
  // act on.
  if (entry?.manifest.type !== "network" || !entry.manifest.network) return notFound;
  return { entry, manifest: entry.manifest.network, report };
}

/** Whether this host's platform is one the plugin declares. Manifest DATA — no plugin code runs. */
export function isSupportedHere(manifest: NetworkManifest, platform: PluginPlatform): boolean {
  return manifest.platforms.includes(platform);
}

/**
 * One operation at a time per plugin, instance-wide.
 *
 * The target is one vendor daemon and one config file, so a second concurrent
 * join or publish would race the first rather than parallelize with it. Held
 * as a module `Set`, and TAKEN SYNCHRONOUSLY — nothing awaits between the test
 * and the insert, so two concurrent requests cannot both see it free.
 */
const inFlight = new Set<string>();

/** Takes the per-plugin lock, or answers false when another act holds it. */
export function beginNetworkOp(id: string): boolean {
  if (inFlight.has(id)) return false;
  inFlight.add(id);
  return true;
}

/** Releases it. Safe to call for a lock this caller never took. */
export function endNetworkOp(id: string): void {
  inFlight.delete(id);
}

/** A plugin resolved, locked and contextualized, ready for an act to run. */
export interface PreparedAct {
  /** The plugin and its manifest. */
  resolved: ResolvedNetwork;
  /** What the plugin is handed on every call: the port, the settings, the secret presence. */
  ctx: NetworkContext;
  /** Releases the per-plugin lock. Every path out of the act must call it exactly once. */
  release: () => void;
}

/**
 * The preamble every act route shares: resolve, check the platform, take the
 * lock, build the context.
 *
 * **Every refusal it can answer with is decided before the caller opens a
 * stream body** — the tmux route's rule (`setup-tmux-install.route.ts`): once
 * a streaming response has sent its status line, a 200 cannot be taken back
 * and a refusal has to arrive as a frame instead, which is a worse thing for a
 * client to handle. So the two streaming routes call this FIRST and only start
 * their body once it has answered.
 *
 * The lock is taken before the context is read, and released by this function
 * on every refusal it returns — a caller that gets a {@link PreparedAct} owns
 * the release.
 */
export async function prepareNetworkAct(id: string): Promise<PreparedAct | NetworkRefusal> {
  const resolved = await resolveNetwork(id);
  if ("status" in resolved) return resolved;
  const platform = networkDeps().platform();
  if (!isSupportedHere(resolved.manifest, platform)) return platformRefusal(resolved.entry, platform);
  // Taken HERE, synchronously: nothing awaits between the test and the insert,
  // so two concurrent requests cannot both see it free.
  if (!beginNetworkOp(id)) return busyRefusal(id);
  try {
    const ctx = await networkContext(id, resolved.entry);
    return { resolved, ctx, release: () => endNetworkOp(id) };
  } catch (err) {
    endNetworkOp(id);
    const reason = err instanceof Error ? err.message : String(err);
    return {
      status: 409,
      code: BackendErrorCodes.NETWORK_NOT_READY,
      message: `The server could not read ${resolved.entry.manifest.name}'s stored settings: ${reason}`,
    };
  }
}

/** The refusal for a busy plugin. */
export function busyRefusal(id: string): NetworkRefusal {
  return {
    status: 409,
    code: BackendErrorCodes.EXISTS_ERROR,
    message: `Another ${id} operation is already running on this server.`,
  };
}

/** The refusal for a platform the plugin does not claim. */
export function platformRefusal(entry: NetworkPluginEntry, platform: PluginPlatform): NetworkRefusal {
  return {
    status: 409,
    code: BackendErrorCodes.PLATFORM_UNSUPPORTED,
    message: `${entry.manifest.name} cannot be driven on ${platform}; it supports ${entry.manifest.network?.platforms.join(" and ") ?? "no platform this build knows"}.`,
  };
}

/** States from which joining or publishing cannot begin. A ladder, so these are the rungs below `needs-login`. */
const NOT_READY_STATES = new Set<NetworkStatus["state"]>(["not-installed", "daemon-down", "needs-privilege"]);

/**
 * The refusal for a host the vendor CLI is not usable on yet, or undefined.
 *
 * The message is the plugin's FIRST hint verbatim, because a hint names the
 * remedy ("Install the daemon", with the command) while the state names only
 * the symptom. A plugin that reports a blocking state with no hint gets a
 * generic sentence rather than an empty one.
 */
export function readinessRefusal(status: NetworkStatus, name: string): NetworkRefusal | undefined {
  if (!NOT_READY_STATES.has(status.state)) return undefined;
  return {
    status: 409,
    code: BackendErrorCodes.NETWORK_NOT_READY,
    message: status.hints[0]?.text ?? `${name} is not ready on this host (${status.state}).`,
  };
}

/**
 * The refusal for a `required` settings field with nothing in it, or undefined.
 *
 * A `secret` field is satisfied by the store HOLDING one, never by a value in
 * the settings object — there is no value there to hold, which is the point of
 * a write-only store. A field carrying a `default` is satisfied by it: the
 * plugin will see that default, so demanding the admin retype it would refuse
 * a configuration that already works.
 *
 * **`act: "join"` exempts required `secret` fields, and only them.** Join is
 * the act that DELIVERS a credential — a paste-box token flows through the
 * join's `credential` argument and into the write-only store (`host.secrets
 * .set`), never into the settings object. Requiring the store to already hold
 * a secret before the act that stores it is the contradiction that made the
 * Cloudflare Tunnel's Connect button structurally dead: the only way to satisfy
 * the gate was to have already performed the gated act. Non-secret required
 * fields (Headscale's control URL, Cloudflare's hostname/team/aud) are NOT
 * exempt — no join delivers them, they must be configured first, and the card
 * renders exactly those under "settings a join cannot proceed without".
 * `publish` passes nothing, so it demands every required field including the
 * secret, because it is downstream of delivery.
 */
export function configurationRefusal(
  entry: NetworkPluginEntry,
  ctx: NetworkContext,
  act: "join" | "publish" = "publish",
): NetworkRefusal | undefined {
  for (const field of entry.plugin.settingsFields?.() ?? []) {
    if (!field.required) continue;
    if (act === "join" && field.type === "secret") continue;
    const set =
      field.type === "secret"
        ? ctx.secrets.has(field.key)
        : (ctx.settings[field.key] ?? "").trim() !== "" ||
          (field.default !== undefined && String(field.default).trim() !== "");
    if (!set) {
      return {
        status: 409,
        code: BackendErrorCodes.NETWORK_UNCONFIGURED,
        message: `${entry.manifest.name} needs "${field.label}" before it can do this. Set it under Settings → Networking.`,
      };
    }
  }
  return undefined;
}

/**
 * How long a `status()` answer is reused (spec § 5.1).
 *
 * Short because every one of these is a live CLI probe on a machine an admin
 * is looking at: long enough that a page rendering six rows and then polling
 * does not spawn a process per row per second, short enough that the answer
 * after an act is the answer after the act.
 */
const STATUS_TTL_MS = 3000;

const statusMemo = new Map<string, { at: number; status: NetworkStatus }>();

/**
 * Drops memoised statuses — one plugin's, or every one.
 *
 * Called by EVERY write route before it answers, because a settings write, a
 * join, a publish and an unpublish all change the thing `status()` reports,
 * and a page that reads back the state it just changed must not be told the
 * previous one.
 */
export function invalidateNetworkStatus(id?: string): void {
  if (id === undefined) statusMemo.clear();
  else statusMemo.delete(id);
}

/**
 * What a plugin that THREW is reported as.
 *
 * `status()` is contractually not allowed to throw — an unreachable daemon is
 * `daemon-down` with a hint — so one that does is a broken plugin, and the
 * row still has to render. `daemon-down` rather than a new state: it is the
 * honest rung (something is installed enough to have code, and it is not
 * answering), and the error rides as the hint so the page says what happened
 * instead of showing an empty card.
 */
function statusFromThrow(name: string, err: unknown): NetworkStatus {
  const reason = err instanceof Error ? err.message : String(err);
  return {
    state: "daemon-down",
    addresses: [],
    hints: [{ text: `${name} could not report its status: ${reason}` }],
  };
}

/**
 * A status as the host is willing to forward it.
 *
 * A network plugin DESCRIBES and the host EXECUTES — and putting a string in
 * front of an admin's browser is an execution. Two fields of a status are URLs
 * a page turns into something a person clicks or pastes, and neither is
 * necessarily the plugin author's own text: a plugin reports what it read off
 * a vendor CLI, and the CLI reports what its control server told it. Tailscale
 * is the worked example — `AuthURL` is chosen by whichever control server the
 * daemon was pointed at, which on a self-hosted Headscale is not Tailscale's.
 *
 * So the URL is dropped and the hint is kept. The sentence beside it is the
 * plugin's own and stays true without a link, where a dropped hint would leave
 * a `needs-login` card saying nothing at all. Refusing the whole plugin would
 * be worse still: nothing about it is broken, and the operator would lose a
 * working network over a value some other machine chose.
 *
 * Note what this does NOT cover: a `JoinOutcome`'s `loginUrl`, which the
 * contract makes required on that variant and which reaches no `href` — it is
 * rendered to copy. A plugin is expected to check its own; Tailscale does.
 */
function forwardableStatus(status: NetworkStatus): NetworkStatus {
  const hints = status.hints.map((hint) => {
    if (hint.docsUrl === undefined || isDocsUrl(hint.docsUrl)) return hint;
    const { docsUrl: _dropped, ...rest } = hint;
    return rest;
  });
  const loginOk = status.loginUrl === undefined || isDocsUrl(status.loginUrl);
  if (loginOk && hints.every((hint, i) => hint === status.hints[i])) return status;
  const next: NetworkStatus = { ...status, hints };
  if (!loginOk) delete next.loginUrl;
  return next;
}

/**
 * One plugin's live status, memoised for {@link STATUS_TTL_MS}.
 *
 * Never throws: see {@link statusFromThrow}. Pass `fresh` to bypass the memo,
 * which every act does for the status it reports back — the memo exists for
 * the polled list, not for the answer to "what did my act just do".
 *
 * What lands in the memo is already {@link forwardableStatus}'d, so the check
 * runs once per probe rather than once per reader.
 *
 * A probe that answers `joined`/`published` also records the addresses and
 * refreshes the registry (`services/network/origins.ts`).
 */
export async function readNetworkStatus(
  entry: NetworkPluginEntry,
  ctx: NetworkContext,
  options: { fresh?: boolean } = {},
): Promise<NetworkStatus> {
  const id = entry.manifest.id;
  const now = Date.now();
  if (!options.fresh) {
    const memo = statusMemo.get(id);
    if (memo && now - memo.at < STATUS_TTL_MS) return memo.status;
  }
  let status: NetworkStatus;
  try {
    status = await entry.plugin.status(ctx);
  } catch (err) {
    status = statusFromThrow(entry.manifest.name, err);
  }
  status = forwardableStatus(status);
  statusMemo.set(id, { at: Date.now(), status });
  // Every uncached probe is an OBSERVATION of this host's addresses, and the
  // trusted-origin registry derives from what is observed — so the page
  // opening, an act's fresh re-read and the boot refresh all keep the
  // allowlist right without any of them knowing it. Best-effort: a record
  // that cannot be written must not turn a status into a failure.
  try {
    await observeNetworkStatus(id, entry.manifest.network, status);
  } catch (err) {
    getLogger().withError(err).warn(`could not record network "${id}"'s addresses from its status`);
  }
  return status;
}

/**
 * Records one network act, AFTER it happened and best-effort.
 *
 * After, because a row for a refused act would record something that did not
 * occur. Best-effort, because a failed audit write must not turn a completed
 * publish into an error — the effect is already on the machine, and reporting
 * it as a failure would be the worse lie.
 *
 * The actor is read back out of the cookie the gate above already validated.
 * **`metadata` must never carry a credential**: a join's pasted key, a secret
 * field's value and a token all stay out of it by construction — the settings
 * route audits field NAMES, and a test scans the serialized metadata for the
 * credential string.
 */
export async function auditNetwork(
  request: Request,
  action: string,
  pluginId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    const actor = await resolveCookieSession(request.headers.get("cookie") ?? "");
    await audit({
      actorUserId: actor?.user.id ?? null,
      action,
      targetType: "plugin",
      targetId: pluginId,
      metadataJson: JSON.stringify(metadata),
    });
  } catch (err) {
    getLogger().withError(err).warn(`could not record the ${action} audit row`);
  }
}

/** What a publish's config write did, as the `done` frame reports it. */
export interface NetworkConfigWrite {
  /** config.env keys this write actually changed. Names only — the values are addresses, and the frame carries those separately. */
  changed: string[];
  /** The CLI writer's own advisory sentences, plus anything this route adds. */
  warnings: string[];
  /** True when every key this publish wanted to write landed in config.env. */
  written: boolean;
  /** The first key that could not be written, when `written` is false. */
  unwritableKey?: string;
}

/** What {@link writePublishConfig} is asked to make true. */
export interface PublishConfigInput {
  /** Origins to ADD to `TRUSTED_ORIGINS`. Never a replacement — see below. */
  origins: string[];
}

/**
 * The config writer's advisories that speak of THIS write's key, or none.
 *
 * (Operator's live read of the Tailscale card, 2026-09-16: a publish that
 * writes `TRUSTED_ORIGINS` and nothing else printed a wall of advice about
 * `HOST` and `APP_BASE_URL` — keys the press had not touched.) `applyConfig`
 * merges the stored values and posture-checks everything it can see, which is
 * right for the CLI and the Service page: they WROTE those keys, and their
 * readers keep every sentence. A network act wrote one. The discriminator is
 * the key's own name, case-sensitively and on purpose: the all-loopback
 * posture names `TRUSTED_ORIGINS` because it describes the list THIS write
 * produced — it stays; the base-URL-port pair offers `--trusted-origins`
 * lower-case as advice for fixing an `APP_BASE_URL` problem, an answer about
 * another key, and drops. The gate's own env-ownership sentence never passes
 * through here — that branch returns before any writer runs — so no filter
 * can silence it.
 */
export function keyOwnWarnings(warnings: string[]): string[] {
  return warnings.filter((warning) => warning.includes("TRUSTED_ORIGINS"));
}

/**
 * The publish's config.env write: `TRUSTED_ORIGINS` ∪ the new origins, and
 * nothing else. The optional `APP_BASE_URL` promotion this writer once took
 * went on 2026-09-16 — the base URL is the Service page's field, and a
 * checkbox in a flow about reaching the server that moved the passkey rpID
 * was the confusion that killed it.
 *
 * Three properties, each load-bearing:
 *
 * - **Union, never replacement.** An origin already trusted stays trusted —
 *   THIS writer never removes anything. Removal is {@link
 *   removePublishedConfig}'s half of the pair: an origin added by a publish
 *   leaves when that publish is undone (spec § 5.4, amended 2026-09-16), and
 *   one this pair never wrote survives every cycle.
 * - **`applyConfig` is the ONLY writer**, shared with `subshell-server
 *   configure` and `PATCH /api/admin/server/config`. That shared call, not a
 *   test, is what makes `docs/security.md`'s component-wise origin validation
 *   and canonical storage true of this feature: there is no second
 *   implementation to drift.
 * - **A key the ENVIRONMENT owns is not written.** A config.env line the next
 *   boot would mask is a success report for a change that never happens, so
 *   the key is dropped, named in `unwritableKey`, and the publish COMPLETES —
 *   the server really is reachable at the address; what could not follow is
 *   the config.
 */
export function writePublishConfig(input: PublishConfigInput): NetworkConfigWrite {
  const deps = networkDeps();
  const warnings: string[] = [];

  let stored: Record<string, string>;
  try {
    stored = deps.configValues();
  } catch (err) {
    // `resolveConfig` throws on a read failure that is not ENOENT. The publish
    // itself already succeeded, so this is a warning on a completed act rather
    // than a refusal — and it names the FILE, which is the thing to fix.
    const reason = err instanceof Error ? err.message : String(err);
    return {
      changed: [],
      warnings: [`The server could not read its config file, so it will not overwrite it: ${reason}`],
      written: false,
      unwritableKey: "TRUSTED_ORIGINS",
    };
  }

  const applied = deps.appliedKeys();
  const env = deps.env();
  const fromEnv = (key: string): boolean => settingSource(key, env, applied, stored) === "process env";

  const patch: ApplyConfigInput = {};
  let unwritableKey: string | undefined;

  if (fromEnv("TRUSTED_ORIGINS")) {
    unwritableKey = "TRUSTED_ORIGINS";
    warnings.push(
      "This server cannot widen the addresses it accepts sign-in from — that list is fixed by the environment it starts in, so the change was not saved; set `TRUSTED_ORIGINS` where the server is started.",
    );
  } else {
    // `DEFAULT_TRUSTED_ORIGINS`, not `""`. The key is ABSENT by default and
    // config.env beats the built-in, so unioning against an empty base writes
    // a file naming only the new origin — which silently strips the dev origins
    // a developer's browser reaches this server on. The boot reconcile already
    // knew this; two writers over one key, one of which knew, is how they
    // disagree.
    patch.trustedOrigins = unionOrigins(
      stored.TRUSTED_ORIGINS ?? env.TRUSTED_ORIGINS ?? DEFAULT_TRUSTED_ORIGINS,
      input.origins,
    ).join(",");
  }

  if (Object.keys(patch).length === 0) {
    return { changed: [], warnings, written: false, ...(unwritableKey ? { unwritableKey } : {}) };
  }

  const result = deps.applyConfig(patch);
  if (!result.ok) {
    const reason = result.kind === "unreadable" ? result.reason : `${result.key}: ${result.reason}`;
    return {
      changed: [],
      warnings: [...warnings, `The address is live, but config.env could not be updated — ${reason}`],
      written: false,
      unwritableKey: unwritableKey ?? (result.kind === "invalid" ? result.key : "TRUSTED_ORIGINS"),
    };
  }
  return {
    changed: result.changed.map((c) => c.key),
    warnings: [...warnings, ...keyOwnWarnings(result.warnings)],
    written: unwritableKey === undefined,
    ...(unwritableKey ? { unwritableKey } : {}),
  };
}

/**
 * The stored origin list plus the new ones, canonicalized, order preserved.
 *
 * Canonicalized HERE as well as inside `applyConfig` so the union compares
 * like with like: `https://x.ts.net/` and `https://x.ts.net` are one origin,
 * and appending the second to a list holding the first would write a duplicate
 * the validator then canonicalizes into a repeat. An entry that will not parse
 * is carried through VERBATIM rather than dropped — `applyConfig`'s validator
 * is what decides whether a stored value is acceptable, and silently deleting
 * a line an operator hand-wrote is not this function's call.
 */
export function unionOrigins(stored: string, added: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...stored.split(","), ...added]) {
    const value = raw.trim();
    if (value === "") continue;
    let canonical = value;
    try {
      canonical = new URL(value).origin;
    } catch {
      // Not a URL. Keep it as written; the validator answers for it.
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

/**
 * The stored origin list with the named ones removed, canonical on both sides.
 *
 * The subtractive mirror of {@link unionOrigins}, keeping its two rules: the
 * comparison runs on `URL.origin`, so a stored `https://x.ts.net/` and a
 * published `https://x.ts.net` are one origin; and an entry that will not
 * parse STAYS — an entry this function cannot understand is not provably one
 * the network published, and deleting what it cannot read is not its call.
 */
export function subtractOrigins(stored: string, removed: string[]): string[] {
  const gone = new Set<string>();
  for (const raw of removed) {
    const value = raw.trim();
    if (value === "") continue;
    try {
      gone.add(new URL(value).origin);
    } catch {
      gone.add(value);
    }
  }
  return stored
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .filter((entry) => {
      try {
        return !gone.has(new URL(entry).origin);
      } catch {
        return true;
      }
    });
}

/**
 * The unpublish's config.env write: `TRUSTED_ORIGINS` minus the origins THIS
 * network's publish added (spec § 5.4, lifecycle amended 2026-09-16 — an
 * origin added by a publish now leaves with that publish).
 *
 * The subtraction of {@link writePublishConfig}, and it inherits that
 * writer's three properties whole: `applyConfig` is the only writer; a key
 * the ENVIRONMENT owns is refused by name — `written: false` and
 * `unwritableKey`, with the unpublish itself completing, because the machine
 * really has stopped publishing and what could not follow is the file — and
 * nothing outside the subtraction's remit is touched. Two rules subtraction
 * adds:
 *
 * - **A line emptied is CLEARED, not written empty** — `applyConfig`'s own
 *   meaning for `trustedOrigins: ""`, the `OPTIONAL_KEYS` rule `configure`
 *   follows. A stale empty line would beat `.env` in the SETDEFAULT ladder
 *   while naming nothing; clearing lets the built-in answer again, exactly
 *   as though the publish had never written the line.
 * - **No match is silence, not a write.** When the file holds none of those
 *   origins — the Addresses card got there first, or an operator hand-edited
 *   the line away — nothing lands and `changed` stays empty. Reporting a
 *   change that did not happen is the same lie as a masked write.
 */
export function removePublishedConfig(origins: string[]): NetworkConfigWrite {
  const deps = networkDeps();
  const warnings: string[] = [];

  let stored: Record<string, string>;
  try {
    stored = deps.configValues();
  } catch (err) {
    // The same shape `writePublishConfig` answers with: the act succeeded,
    // the file could not be read, and the FILE is the thing to fix.
    const reason = err instanceof Error ? err.message : String(err);
    return {
      changed: [],
      warnings: [`The server could not read its config file, so it will not overwrite it: ${reason}`],
      written: false,
      unwritableKey: "TRUSTED_ORIGINS",
    };
  }

  if (stored.TRUSTED_ORIGINS === undefined) {
    // The key is absent from the file. Whatever trusts that address today
    // lives in the environment or in the built-in default, and neither is
    // this write's to touch. Nothing changed; nothing failed. (The asymmetry
    // against `writePublishConfig`, which DOES consult the environment here:
    // the union would write a line the environment masks, while a subtraction
    // from an absent file removes nothing — an env refusal would name a
    // problem that does not exist.)
    return { changed: [], warnings, written: true };
  }

  const applied = deps.appliedKeys();
  const env = deps.env();
  if (settingSource("TRUSTED_ORIGINS", env, applied, stored) === "process env") {
    return {
      changed: [],
      warnings: [
        "This server cannot take addresses out of the list it accepts sign-in from — that list is fixed by the environment it starts in, so nothing was removed; drop them from `TRUSTED_ORIGINS` where the server is started.",
      ],
      written: false,
      unwritableKey: "TRUSTED_ORIGINS",
    };
  }

  const remaining = subtractOrigins(stored.TRUSTED_ORIGINS, origins);
  if (remaining.length === subtractOrigins(stored.TRUSTED_ORIGINS, []).length) {
    return { changed: [], warnings, written: true };
  }

  const result = deps.applyConfig({ trustedOrigins: remaining.join(",") });
  if (!result.ok) {
    const reason = result.kind === "unreadable" ? result.reason : `${result.key}: ${result.reason}`;
    return {
      changed: [],
      warnings: [...warnings, `The publish was undone, but config.env could not be updated — ${reason}`],
      written: false,
      unwritableKey: "TRUSTED_ORIGINS",
    };
  }
  return {
    changed: result.changed.map((c) => c.key),
    warnings: [...warnings, ...keyOwnWarnings(result.warnings)],
    written: true,
  };
}
