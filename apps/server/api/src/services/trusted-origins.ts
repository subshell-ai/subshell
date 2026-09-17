import { configEnvAppliedKeys, resolveConfig } from "@/config-env.js";
import { APP_BASE_URL, DEFAULT_TRUSTED_ORIGINS, HOST, localOriginsFor, SERVER_PORT } from "@/constants.js";
import { lanOrigins } from "@/services/lan-origins.js";
import { settingSource } from "@/services/server-deployment.js";
import { getLogger } from "@/utils/logger.js";

/**
 * The origins a browser may sign in from, assembled LIVE from four sources:
 *
 *   effective = localOriginsFor(port, host, baseUrl)
 *             ∪ lanOrigins(port, host)          // the machine's own interfaces, wildcard bind only
 *             ∪ the operator's own `TRUSTED_ORIGINS` extras
 *             ∪ ⋃ (enabled network plugin p) originsOf(p)
 *
 * Until 2026-09-16 this was a frozen array built once at import
 * (`constants.ts`), which better-auth and the CORS plugin each captured. A
 * network plugin that published wrote its addresses INTO config.env and
 * reported `restartRequired`, because the list was read at boot. Measured on
 * a `HOST=0.0.0.0` instance: the tailnet address served the app (200) and a
 * sign-in from it was 403 "Invalid origin" — reachability is a network fact
 * and only the allowlist stood in the way. Now the plugin's RECORD is the
 * source and the registry follows it; config.env's key is the operator's
 * extras and nothing else.
 *
 * What did NOT change is the DNS-rebinding rule (docs/security.md §8): no
 * entry here is ever derived from a request's Host or Origin header. Plugin
 * addresses are the local daemon's self-report of THIS host's addresses, the
 * LAN probe is the kernel's own answer for this host, and the operator list
 * is a file this process owns.
 *
 * Singleton per the code-style rule, constructed on FIRST USE: better-auth
 * invokes the function form per request and once at its own init, the CORS
 * plugin per request, and `constants.ts` must stay IO-free at import
 * (`__tests__/auth-import-purity.test.ts`).
 */

/** The seams the unit test replaces. */
export interface OriginRegistryDeps {
  /** This instance's own origins. Production: `localOriginsFor(SERVER_PORT, HOST, APP_BASE_URL)` plus the live `lanOrigins(SERVER_PORT, HOST)` probe. */
  localOrigins(): readonly string[];
  /** The operator's raw comma-joined `TRUSTED_ORIGINS` as it stands NOW — the file's, or the environment's when the environment owns the key. */
  readStored(): string;
  /** Where refusals and set changes are said. */
  log: { info(message: string): void; warn(message: string): void };
}

/** The live allowlist. */
export interface OriginRegistry {
  /** The effective allowlist: local, then operator extras, then plugins by id — deduped, first occurrence wins, frozen. */
  current(): readonly string[];
  /** Exact-match membership of a serialized origin (what `Origin:` carries). */
  has(origin: string): boolean;
  /** The operator list as last loaded, comma-joined — what the deployment view reports as running. */
  storedValue(): string;
  /** Re-reads the operator list through `readStored`. Called after every config.env write that touched the key. */
  reloadStored(): void;
  /**
   * Re-asks `localOrigins()` and rebuilds the effective set. Called by
   * `GET /api/settings/public`, which is the request a person makes RIGHT
   * BEFORE handing a phone an address — interfaces change without a restart
   * or an act, and `localOrigins()` now includes the live LAN probe, so a
   * laptop that switched Wi-Fi must not offer the address of the network it
   * left. Plugin sets and the operator list are untouched by this.
   */
  refreshLocal(): void;
  /** Replaces one plugin's whole contribution; each entry canonicalized or dropped with a warn. */
  setPluginOrigins(pluginId: string, origins: readonly string[]): void;
  /** Removes one plugin's contribution entirely. */
  clearPlugin(pluginId: string): void;
  /** One plugin's accepted origins, for tests and log lines. */
  pluginOrigins(pluginId: string): readonly string[];
}

/**
 * One plugin-reported address as an origin, or null when it cannot be one.
 *
 * `URL.origin` because both consumers compare against the exact string a
 * browser sends. Refused before that: a `*`/`?` in the AUTHORITY — better-auth
 * routes such a pattern through `wildcardMatch`, so `https://*` would trust
 * every https origin (`commands/config-values.ts` refuses the same for the
 * operator list; this is the plugin-side twin of that refusal), and a `?`
 * there is a vendor CLI value truncated at a query separator (`http://ip?.x`
 * parses to the host `ip`, which is not the address that was reported) —
 * and the literal `"null"`, which is what an opaque origin serializes to.
 * A `?` or `*` after the authority is a query or path, which `URL.origin`
 * discards, so it is not refused. Nothing here throws: a plugin's bad
 * address costs the plugin that one entry, never the allowlist.
 */
export function canonicalPluginOrigin(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;
  const schemeSep = value.indexOf("://");
  const afterScheme = schemeSep === -1 ? value : value.slice(schemeSep + 3);
  if (/[*?]/.test(afterScheme.split(/[/#]/)[0] ?? "")) return null;
  let origin: string;
  try {
    origin = new URL(value).origin;
  } catch {
    return null;
  }
  return origin === "null" ? null : origin;
}

/** Splits the operator list the way `constants.ts` did: trimmed, empties dropped, otherwise VERBATIM. */
function splitStored(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Builds a registry over the given seams. Exported for the unit test; the
 * server uses {@link originRegistry}.
 *
 * Operator entries are NOT canonicalized or wildcard-filtered here: `applyConfig`
 * already did that for anything the CLI or the dashboard wrote, and an env var
 * or hand-edit carrying a pattern is a supported escape hatch (AGENTS.md,
 * "Wildcards are the deliberate silence"). Plugin entries ARE, because a
 * plugin's address is a vendor CLI's word, not an operator's.
 */
export function createOriginRegistry(deps: OriginRegistryDeps): OriginRegistry {
  const plugins = new Map<string, string[]>();
  let stored = deps.readStored();
  let effective: readonly string[] = Object.freeze([] as string[]);
  let effectiveSet = new Set<string>();

  /** Rebuilds the effective set; says what changed when `cause` is given. */
  function recompute(cause?: string): void {
    const next = [
      ...new Set([
        ...deps.localOrigins(),
        ...splitStored(stored),
        ...[...plugins.keys()].sort().flatMap((id) => plugins.get(id) ?? []),
      ]),
    ];
    const added = next.filter((origin) => !effectiveSet.has(origin));
    const removed = effective.filter((origin) => !next.includes(origin));
    effective = Object.freeze(next);
    effectiveSet = new Set(next);
    if (cause !== undefined && (added.length > 0 || removed.length > 0)) {
      const delta = [...added.map((o) => `+${o}`), ...removed.map((o) => `-${o}`)].join(" ");
      deps.log.info(`trusted origins changed (${cause}): ${delta}`);
    }
  }
  recompute();

  return {
    current: () => effective,
    has: (origin) => effectiveSet.has(origin),
    storedValue: () => stored,
    reloadStored() {
      stored = deps.readStored();
      recompute("operator list reloaded");
    },
    refreshLocal() {
      recompute("local interfaces");
    },
    setPluginOrigins(pluginId, origins) {
      const accepted: string[] = [];
      for (const raw of origins) {
        const canonical = canonicalPluginOrigin(raw);
        if (canonical === null) {
          deps.log.warn(
            `network plugin "${pluginId}" reported an address that cannot be a trusted origin, so it was not trusted: ${raw}`,
          );
          continue;
        }
        if (!accepted.includes(canonical)) accepted.push(canonical);
      }
      const before = plugins.get(pluginId);
      if (before !== undefined && before.length === accepted.length && before.every((o, i) => o === accepted[i]))
        return;
      plugins.set(pluginId, accepted);
      recompute(`plugin "${pluginId}"`);
    },
    clearPlugin(pluginId) {
      if (!plugins.delete(pluginId)) return;
      recompute(`plugin "${pluginId}" cleared`);
    },
    pluginOrigins: (pluginId) => plugins.get(pluginId) ?? [],
  };
}

/**
 * The production seams.
 *
 * **Environment ownership is decided ONCE, here, before any config.env write
 * this process makes.** The rule is `settingSource`'s (the PATCH route's 409
 * and the deployment view use the same one), but it cannot be re-asked after
 * a write: under systemd every key arrives through `EnvironmentFile=`, so once
 * the file has changed, env ≠ file reads as "the environment overrides it" and
 * the operator's live change would be ignored on the one platform it is most
 * used on. Asked at construction — boot, before the listener — env equals file
 * there and the key is correctly the file's for the life of the process.
 *
 * **`process.env` is kept in step when it already shadows the file.** The
 * loader put the file's value there at boot (`loadConfigEnv`), and the
 * deployment view's `saved` reads `process.env` first (`collectStatus`), so
 * without this a live change would be reported as awaiting a restart — the
 * exact lie this registry removes — and a second PATCH on a systemd host would
 * be 409'd as environment-owned. Only a key the environment never held stays
 * untouched; an env-owned key is never written.
 */
function productionDeps(): OriginRegistryDeps {
  const fileValues = (): Record<string, string> | null => {
    try {
      return resolveConfig().values;
    } catch (err) {
      getLogger()
        .withError(err)
        .warn("could not read config.env; the trusted-origin list keeps its last operator value");
      return null;
    }
  };
  const envOwned =
    settingSource("TRUSTED_ORIGINS", process.env, configEnvAppliedKeys(), fileValues() ?? {}) === "process env";
  let last = process.env.TRUSTED_ORIGINS ?? DEFAULT_TRUSTED_ORIGINS;
  return {
    // The LAN probe runs at every recompute, not once at construction: the
    // answer changes without an act (Wi-Fi switch, VPN up/down), and the only
    // cost is one getifaddrs behind a refresh that `GET /api/settings/public`
    // asks for — the request made right before a phone is handed an address.
    localOrigins: () => [...localOriginsFor(SERVER_PORT, HOST, APP_BASE_URL), ...lanOrigins(SERVER_PORT, HOST)],
    readStored: () => {
      if (envOwned) return process.env.TRUSTED_ORIGINS ?? DEFAULT_TRUSTED_ORIGINS;
      const values = fileValues();
      if (values === null) return last;
      const value = values.TRUSTED_ORIGINS;
      if (process.env.TRUSTED_ORIGINS !== undefined) {
        if (value === undefined) delete process.env.TRUSTED_ORIGINS;
        else process.env.TRUSTED_ORIGINS = value;
      }
      last = value ?? DEFAULT_TRUSTED_ORIGINS;
      return last;
    },
    log: { info: (m) => getLogger().info(m), warn: (m) => getLogger().warn(m) },
  };
}

let instance: OriginRegistry | undefined;

/**
 * The registry (singleton per the code-style rule), built on FIRST USE. Every
 * caller is per-request or at boot — after module evaluation — so the laziness
 * is invisible in behaviour and visible only in the absence of import-time
 * reads of config.env.
 */
export function originRegistry(): OriginRegistry {
  instance ??= createOriginRegistry(productionDeps());
  return instance;
}

/**
 * Drops the memoized instance. Only for tests that need a fresh build.
 * @internal
 */
export function resetOriginRegistryForTests(): void {
  instance = undefined;
}
