import { Database } from "bun:sqlite";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DEFAULT_DATABASE_PATH, lingerVerdict, NODE_TARGETS } from "@internal/subshell-protocol";
import { baseUrlProblem, originProblem } from "@/commands/config-values.js";
import { resolveConfig } from "@/config-env.js";
import {
  DATABASE_PATH,
  DEFAULT_TRUSTED_ORIGINS,
  NODE_ARTIFACTS_DIR,
  SUBSHELL_PLUGIN_REGISTRY_URL,
  SUBSHELL_SERVER_DATA_DIR,
} from "@/constants.js";
import { publishedNodeTargets } from "@/lib/node-artifacts.js";
import { type ServiceState, SYSTEMD_UNIT_NAME, serviceArtifactPath } from "@/service.js";
import { type McpResolveIo, probeMcpLaunch } from "@/services/mcp-resolve.js";
import { subshellLogDir } from "@/services/nodes/subshell-paths.js";
import { serverLogPath } from "@/utils/log-file.js";
import { SERVER_VERSION } from "@/version.js";

/**
 * `subshell-server status` — "what WOULD this boot with", as data and as text.
 *
 * Split out of `cli.ts` (which stays dispatch) beside `configure.ts`/`init.ts`,
 * and because {@link StatusView} stopped being an internal detail the moment
 * `--json` made it a contract another process reads.
 *
 * Everything here is READ-ONLY and SYNCHRONOUS: `cli.ts` invariant 1 forbids a
 * handled command from suspending before `process.exit`, which is also why the
 * port probe reads the kernel's listener tables instead of dialing.
 */

/** Injected seams — structurally a subset of `CliDeps`, declared here so this module does not import `cli.ts`. */
export interface StatusDeps {
  probePort?: (host: string, port: number) => boolean | null;
  platform?: NodeJS.Platform;
  home?: string;
  mcpIo?: McpResolveIo;
}

/** Where a resolved setting came from — the layer attribution `status` prints in parentheses. */
export type SettingSource = "process env" | "config.env" | "default";

/** One unusable piece of a setting's value. */
export interface SettingProblem {
  /**
   * The offending entry — one comma-separated item, or the whole value for a
   * single-valued key. ALWAYS a slice of the setting's own `value`, which is
   * what keeps this field from introducing a new class of data into the view
   * (pinned by `__tests__/cli.test.ts`).
   */
  entry: string;
  /** What a browser will actually do, in one sentence. Rendered verbatim by both views. */
  reason: string;
}

/** One resolved setting plus the layer it came from. */
export interface StatusSetting {
  /** The effective value the server would boot with. */
  value: string;
  /** Which layer of `process env > config.env > .env > defaults` supplied it. */
  source: SettingSource;
  /**
   * Per-entry problems with this value; ABSENT when it is usable, never `[]`
   * — so every other key's shape is unchanged and a consumer gating on
   * `problems?.length` cannot draw an empty warning.
   *
   * Diagnostic, never a verdict. The boot ACCEPTS these values; this says what
   * a browser will do with them. Deliberately no `ok` boolean: the moment
   * there is one, a caller branches on it and someone later makes it block a
   * save — and the decision here was warn-don't-refuse, because refusing at
   * boot would brick the `configure` that repairs the value.
   *
   * It exists because a boot-time check cannot work. `constants.ts` is
   * imported by every subcommand, so a throw there kills `configure` too; and
   * a boot WARNING cannot name the LAYER a value came from, so it sends an
   * operator to edit a config.env they already got right. `status` carries the
   * layer, is read-only, always exits 0, and is already what the desktop
   * console reads.
   */
  problems?: SettingProblem[];
}

/** The keys `configure` owns, and the only ones `status` resolves. */
export type StatusSettingKey = "SERVER_PORT" | "HOST" | "APP_BASE_URL" | "DATABASE_PATH" | "TRUSTED_ORIGINS";

/**
 * Everything `status` knows, as data.
 *
 * The text and `--json` renderings are two views of THIS object rather than
 * two computations, so they cannot disagree about the same host — the same
 * "ONE fact, ONE spelling" rule that put the version line at the top.
 *
 * Deliberately absent: the auth secret in any form. {@link authSecret} is a
 * two-state string, and a test scans the serialized JSON for the real value.
 */
export interface StatusView {
  /** Byte-identical to what the `version` subcommand prints. */
  version: string;
  /** The config file's resolved path, and whether it is there. A consumer branches on `exists` to offer `init`. */
  configEnv: { path: string; exists: boolean };
  /**
   * The absolute locations instance data lives at, as THIS process
   * resolved them. `status` is the authority on where the server's data is -
   * the desktop app's reset deletes exactly these and nothing else, which is
   * why they travel as data instead of being re-derived elsewhere. Read-only,
   * like everything here; presence with an unusable value is impossible
   * because these are already-resolved constants.
   */
  paths: { dataDir: string; database: string; logsDir: string; nodeArtifacts: string; serverLog: string };
  /** The `configure`-owned keys, each with its layer attribution. */
  settings: Record<StatusSettingKey, StatusSetting>;
  /** Presence only — never the value. */
  authSecret: { state: "set" | "missing"; source: SettingSource };
  /** Absolute path to tmux, or `null` when it is not on PATH (every local pane needs it). */
  tmux: string | null;
  /** The resolved `subshell mcp` entrypoint; `null` when none resolved, in which case subshell create would 500. */
  mcp: { command: string; args: string[]; source: string } | null;
  /** Why the MCP entrypoint did not resolve; `null` when it did. */
  mcpError: string | null;
  /**
   * The npm registry a `spec` install fetches from (phase 3), trailing slash
   * already stripped. The URL is ALSO the integrity authority: the digest a
   * tarball must match is the one THIS registry announced, so changing the
   * registry is changing who an install trusts. Printed beside `mcp
   * entrypoint` for the tmux reason: a deploy-time fact better named before
   * a fetch fails than after.
   */
  pluginRegistry: string;
  /**
   * `port` is the parsed number, `null` when `portRaw` is not a valid port —
   * so a consumer never has to re-parse, and a malformed value stays visible.
   */
  listen: { host: string; port: number | null; portRaw: string; portValid: boolean; listening: boolean };
  /** The DEFINITION-on-disk check only. `service status` answers what the manager is doing. */
  service: { definitionPath: string | null; installed: boolean };
  /**
   * How many agent binaries this host can actually serve.
   *
   * The enroll one-liner (`/install.sh`) can only hand out what sits on this
   * disk, and a binary-only install ships NONE of them — so the Nodes page
   * fails at the user's terminal until someone runs `release:node`. Same
   * class of deploy-time fact as tmux and the MCP rung: print it before
   * anyone has to discover it.
   */
  nodeArtifacts: { published: number; total: number; dir: string };
  /**
   * Whether this instance has an admin account yet — the first question a
   * stuck operator has, and the one `status` could not answer.
   *
   * Nothing in the CLI ever said that a freshly configured server hands its
   * first visitor a setup wizard, so an install that is working perfectly and
   * one that is broken printed the same output. This is the line that tells
   * them apart, and the URL to open when the answer is "not yet".
   */
  setup: {
    /**
     * Whether the database the boot would open exists. `missing` is the
     * ordinary state of a configured server that has never been started —
     * migrations create the file — so it is a stage of setup, not a fault.
     */
    database: "missing" | "present";
    /**
     * True once at least one account exists. `null` means the question could
     * not be answered: the database is absent, or it could not be read.
     * Never a throw — `status` always exits 0, so an unreadable file is an
     * unknown answer rather than a failed command.
     */
    hasUsers: boolean | null;
  };
}

/** True while a test runner is active (`bun test` sets `NODE_ENV=test`). */
function underTest(): boolean {
  return process.env.NODE_ENV === "test" || process.env.SUBSHELL_TEST_MODE === "1";
}

/**
 * Whether a path sits under the OS temp directory, compared through the
 * deepest ancestor that exists — a database that was never created cannot be
 * realpath'd, and on macOS the unresolved `/var/folders` spelling never
 * prefix-matches the resolved `/private/var` one.
 */
function withinTmp(path: string): boolean {
  const real = (p: string): string => {
    let cur = resolve(p);
    const tail: string[] = [];
    for (;;) {
      try {
        return tail.length === 0 ? realpathSync(cur) : join(realpathSync(cur), ...tail);
      } catch {
        const parent = dirname(cur);
        if (parent === cur) return resolve(p);
        tail.unshift(basename(cur));
        cur = parent;
      }
    }
  };
  const tmp = real(tmpdir());
  const target = real(path);
  return target === tmp || target.startsWith(`${tmp}/`);
}

/**
 * Count accounts in the database at `path`, without ever throwing.
 *
 * Opened INSIDE `collectStatus` rather than through the app's own Kysely
 * handle: this package pins its CLI entry graph IO-free at import (see
 * `cli.ts` invariant 2), and `@/db/index.js` opens SQLite when it is
 * evaluated. `create: false` is what keeps `status` from conjuring the very
 * database whose absence it reports, or running a migration as a side effect
 * of being asked a question.
 *
 * `user_meta` is the instance's own "a user exists" truth (the same table
 * `GET /api/setup/status` counts), and a database too old or too damaged to
 * hold it answers `null` like any other read failure.
 *
 * **Read-only is TRIED, not required, and that is the whole subtlety.**
 * Reading a WAL database needs a writable `-shm` beside it, which a read-only
 * connection may not create — so on a database whose sidecars are gone (a
 * restored backup, a copied instance, any client that closed cleanly) SQLite
 * opens fine and then throws "unable to open database file" on the first
 * query. Measured on bun 1.4.2. Falling back to a read-write handle is what
 * keeps `status` from calling a perfectly good database unreadable; it still
 * creates no database, and by then no live writer holds the file, since a
 * running server is exactly the case where the `-shm` exists and the
 * read-only open already worked.
 *
 * **It does write, despite never creating a database.** The read-write
 * fallback is what lets SQLite build the `-shm`/`-wal` sidecars a WAL database
 * needs, so a `status` run on an instance whose sidecars are gone leaves them
 * behind (measured on bun 1.4.2, review 2026-09-15). Harmless as the owning
 * user; running `status` as root against a per-user instance would leave
 * root-owned sidecars the server then cannot write.
 *
 * @returns the account count, or null when the database could not be read
 */
function countAccounts(path: string): number | null {
  // A test must never open the DEVELOPER'S live database. `status` resolves its
  // path out of config.env, so a test that does not pin
  // SUBSHELL_SERVER_CONFIG_DIR reads ~/.config/subshell-server/config.env and
  // opens whatever instance the operator actually runs — and the read-write
  // fallback below then writes its `-shm`/`-wal` sidecars. Measured
  // 2026-09-15: the suite was touching the live database on every run.
  //
  // Returning null rather than throwing is deliberate: this reports "could not
  // read", which is exactly what a test asking about a database it never set up
  // should see, and it keeps `status` honest about never throwing.
  if (underTest() && !withinTmp(path)) return null;
  const count = (mode: { readonly: true } | { readwrite: true; create: false }): number | null => {
    let db: Database | undefined;
    try {
      db = new Database(path, mode);
      const row = db.query("SELECT count(*) AS n FROM user_meta").get() as { n: number } | null;
      return row === null ? null : Number(row.n);
    } catch {
      return null;
    } finally {
      try {
        db?.close();
      } catch {
        // A handle that would not close is not a reason to fail a read-only view.
      }
    }
  };
  return count({ readonly: true }) ?? count({ readwrite: true, create: false });
}

/** Gather the whole `status` picture. Reads only — no writes, no boot, no mutation of `process.env`. */
export function collectStatus(deps: StatusDeps): StatusView {
  const cfg = resolveConfig();
  // Layer attribution. The prelude applies config.env to process.env BEFORE
  // dispatch (the boot path needs it), so a file-sourced key is already
  // indistinguishable by presence — match the value against the file instead.
  // A real env var that happens to equal its config.env line reports as
  // config.env: harmless, both layers agree.
  const tag = (key: string): SettingSource => {
    if (process.env[key] === undefined) return cfg.values[key] !== undefined ? "config.env" : "default";
    if (cfg.values[key] === process.env[key]) return "config.env";
    return "process env";
  };
  /**
   * Build one setting, attaching problems only when `probe` finds any.
   *
   * The predicates live in `commands/config-values.ts` beside the validator
   * `configure` uses, and share its primitives — a `status` that called a
   * value unusable when `configure` would accept it (or the reverse) would
   * make the tool look broken rather than the config.
   */
  const setting = (key: string, value: string, probe?: (v: string) => SettingProblem[]): StatusSetting => {
    const found = probe?.(value) ?? [];
    return { value, source: tag(key), ...(found.length > 0 ? { problems: found } : {}) };
  };

  /** Per-entry problems for a comma-separated origin list. */
  const originProblems = (value: string): SettingProblem[] =>
    value
      .split(",")
      .map((raw) => raw.trim())
      .filter(Boolean)
      .flatMap((entry) => {
        const reason = originProblem(entry);
        return reason === null ? [] : [{ entry, reason }];
      });

  /** The base URL is single-valued, so the whole value is the entry. */
  const baseUrlProblems = (value: string): SettingProblem[] => {
    const reason = baseUrlProblem(value);
    return reason === null ? [] : [{ entry: value, reason }];
  };

  // Mirrors of constants.ts defaults (imported by the boot path only; kept in
  // sync deliberately — importing constants here would run dotenvx in a CLI
  // process). SERVER_PORT/HOST/APP_BASE_URL defaults live there.
  const portRaw = cfg.get("SERVER_PORT") ?? "3080";
  const host = cfg.get("HOST") ?? "0.0.0.0";

  // Can THIS process spawn `subshell mcp`? Every subshell create registers it
  // into the harness config, so an unresolvable entrypoint means create 500s.
  // The probe reads the merged env (the prelude applied config.env before
  // dispatch), so SUBSHELL_MCP_COMMAND from the file counts.
  const mcpProbe = probeMcpLaunch(process.env, deps.mcpIo ?? {});

  // Liveness: is something already listening on the resolved port? A bind
  // there would EADDRINUSE the boot, so "likely running" is the actionable
  // half of this line. 0.0.0.0/:: are bind addresses, never dial targets —
  // reported as-is, dialed as loopback.
  const dialHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const portNum = Number.parseInt(portRaw, 10);
  // Strict on purpose: "3080abc" parses to 3080 but is NOT what the boot path
  // accepts, so reporting it valid would promise a boot that fails.
  const portValid = String(portNum) === portRaw.trim() && portNum >= 1 && portNum <= 65535;
  const listening = portValid ? ((deps.probePort ?? syncPortListening)(dialHost, portNum) ?? false) : false;

  // The config dir is passed so a darwin service installed with
  // `--no-autostart` — whose plist lives there rather than in
  // `~/Library/LaunchAgents` — is reported as installed rather than absent.
  const svc = serviceArtifactPath(deps.platform ?? process.platform, deps.home ?? homedir(), dirname(cfg.path));

  // The database the BOOT would open, resolved through the same ladder as
  // every other setting here — not the already-imported DATABASE_PATH
  // constant, which `paths` reports and which under IS_TEST names a fixture
  // rather than what this config says.
  const dbPath = cfg.get("DATABASE_PATH") ?? DEFAULT_DATABASE_PATH;
  const dbExists = existsSync(dbPath);
  const accounts = dbExists ? countAccounts(dbPath) : null;

  return {
    version: SERVER_VERSION,
    configEnv: { path: cfg.path, exists: cfg.exists },
    paths: {
      dataDir: SUBSHELL_SERVER_DATA_DIR,
      database: DATABASE_PATH,
      logsDir: subshellLogDir(),
      nodeArtifacts: NODE_ARTIFACTS_DIR,
      // The server's OWN log — one 200 KB file, replaced when full. It lives
      // inside dataDir, so a reset that deletes the data directory covers it.
      serverLog: serverLogPath(),
    },
    settings: {
      SERVER_PORT: setting("SERVER_PORT", portRaw),
      HOST: setting("HOST", host),
      APP_BASE_URL: setting("APP_BASE_URL", cfg.get("APP_BASE_URL") ?? `http://localhost:${portRaw}`, baseUrlProblems),
      DATABASE_PATH: setting("DATABASE_PATH", cfg.get("DATABASE_PATH") ?? DEFAULT_DATABASE_PATH),
      // Reported with the real built-in default rather than an empty string,
      // because the point of this view is "what WOULD this boot with" — the
      // boot trusts those two dev origins when the key is unset, and saying
      // "" here would be a lie a consumer could act on. Consumers that need
      // "has anyone chosen this" read `source === "default"`.
      TRUSTED_ORIGINS: setting(
        "TRUSTED_ORIGINS",
        cfg.get("TRUSTED_ORIGINS") ?? DEFAULT_TRUSTED_ORIGINS,
        originProblems,
      ),
    },
    authSecret: {
      state: cfg.get("BETTER_AUTH_SECRET") !== undefined ? "set" : "missing",
      source: tag("BETTER_AUTH_SECRET"),
    },
    tmux: Bun.which("tmux"),
    mcp: mcpProbe.spec
      ? { command: mcpProbe.spec.command, args: [...mcpProbe.spec.args], source: mcpProbe.source }
      : null,
    mcpError: mcpProbe.spec ? null : mcpProbe.error,
    pluginRegistry: SUBSHELL_PLUGIN_REGISTRY_URL,
    listen: { host: dialHost, port: portValid ? portNum : null, portRaw, portValid, listening },
    service: { definitionPath: svc, installed: svc !== null && existsSync(svc) },
    nodeArtifacts: {
      published: publishedNodeTargets().length,
      total: NODE_TARGETS.length,
      dir: NODE_ARTIFACTS_DIR,
    },
    setup: {
      database: dbExists ? "present" : "missing",
      hasUsers: accounts === null ? null : accounts > 0,
    },
  };
}

/**
 * The human rendering — one aligned line per fact. Names the BUILD first: the
 * question status exists to answer, in the byte-identical string the `version`
 * subcommand prints.
 */
export function runStatus(log: (line: string) => void, deps: StatusDeps): void {
  const v = collectStatus(deps);
  const field = (key: StatusSettingKey): void => {
    const s = v.settings[key];
    log(`${key.padEnd(20)} = ${s.value}  (${s.source})`);
    // Indented under the value it is about, and printed VERBATIM — both views
    // render what the object says rather than computing a second wording.
    for (const problem of s.problems ?? []) log(`${" ".repeat(23)}! ${problem.reason}`);
  };

  log(`subshell-server ${v.version}`);
  log(`config.env: ${v.configEnv.path} (${v.configEnv.exists ? "present" : "missing"})`);
  field("SERVER_PORT");
  field("HOST");
  field("APP_BASE_URL");
  field("TRUSTED_ORIGINS");
  field("DATABASE_PATH");
  // Never echo the secret — masked/missing is all status reveals.
  const secretText = v.authSecret.state === "set" ? "set (masked)" : "MISSING";
  log(`BETTER_AUTH_SECRET   = ${secretText}  (${v.authSecret.source})`);
  log(`tmux                 = ${v.tmux ?? "NOT FOUND: install tmux (apt install tmux / brew install tmux)"}`);
  log(
    v.mcp
      ? `mcp entrypoint       = ${[v.mcp.command, ...v.mcp.args].join(" ")}  (via ${v.mcp.source})`
      : `mcp entrypoint       = UNRESOLVED; subshell create will fail; ${v.mcpError}`,
  );
  log(`plugin registry      = ${v.pluginRegistry}`);
  const { published, total, dir } = v.nodeArtifacts;
  log(
    `node artifacts       = ${published}/${total} published (${dir})` +
      (published < total ? ", install.sh 404s for the rest" : ""),
  );
  // The one line that says whether anyone can sign in yet. It names the URL
  // only while opening it is the next thing to do — an instance that has an
  // admin must not keep advertising a wizard that will refuse.
  const setup =
    v.setup.database === "missing"
      ? "database not created yet (the server has not booted)"
      : v.setup.hasUsers === null
        ? `database present but unreadable (${v.settings.DATABASE_PATH.value})`
        : v.setup.hasUsers
          ? "admin account exists"
          : `no admin account yet — open ${v.settings.APP_BASE_URL.value}/setup`;
  log(`setup                = ${setup}`);
  log(`port ${v.listen.portRaw} on ${v.listen.host}: ${v.listen.listening ? "likely running" : "not listening"}`);
  // Service DEFINITION on disk — not a liveness line (`service status` is the
  // real answer; the port probe above is the closest this view gets).
  if (v.service.definitionPath === null) {
    log("service              = n/a (no per-user service manager on this platform)");
  } else {
    const p = v.service.definitionPath;
    log(`service              = ${v.service.installed ? `definition installed (${p})` : `not installed (${p})`}`);
  }
}

/** The human rendering of {@link ServiceState} — `service status` without `--json`. */
export function serviceStateLines(state: ServiceState): string[] {
  if (state.definitionPath === null) {
    return ["service              = n/a (no per-user service manager on this platform)"];
  }
  if (!state.installed) {
    return [
      `service              = not installed (${state.definitionPath})`,
      "run `subshell-server service install` to background the server",
    ];
  }
  const lines = [
    `service              = definition installed (${state.definitionPath})`,
    `state                = ${state.state}${state.pid !== null ? ` (pid ${state.pid})` : ""}`,
    `starts at login      = ${state.enabled === null ? "unknown" : state.enabled ? "yes" : "no"}`,
  ];
  // Linux only, and only where a systemd definition is what we are describing:
  // launchd has no lingering knob, so the line would be a question with no
  // answer rather than an unknown one. "Starts at login" above is the enabled
  // unit; this is whether a machine nobody logs into ever reaches that login.
  if (state.definitionPath.endsWith(SYSTEMD_UNIT_NAME)) {
    // Shared with the agent's own `service status`, which answers the same
    // question about the same mechanism: two spellings of it is the kind of
    // drift nobody notices and everybody reconciles later.
    lines.push(`survives logout      = ${lingerVerdict(state.linger)}`);
  }
  // The one line an operator cannot get out of systemctl/launchctl, and the
  // one that decides whether stopping or restarting here costs them their work.
  const pane =
    state.paneSafety === "keeps"
      ? "yes"
      : state.paneSafety === "kills"
        ? "NO: this definition predates the fix; reinstall it before stopping or restarting"
        : "unknown: the definition could not be read";
  lines.push(`teardown keeps panes = ${pane}`);
  if (state.detail !== "") lines.push(`detail               = ${state.detail}`);
  return lines;
}

/**
 * Synchronous "is anything LISTENing on this port" check. A TCP connect is
 * the obvious probe but it is inherently async — and async suspends the
 * entry mid-command (see invariant 1 in `cli.ts`) — so status reads the
 * kernel's listener tables instead: `/proc/net/tcp{,6}` on Linux (state 0A
 * = LISTEN), `netstat -an -p tcp` on macOS, plain `netstat -tnl` elsewhere.
 * Returns null when no source is available (degrades to "not listening" —
 * this is a hint line, not an oracle).
 */
export function syncPortListening(
  _host: string,
  port: number,
  platform: NodeJS.Platform = process.platform,
): boolean | null {
  if (platform === "linux") {
    let sawAny = false;
    for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let text: string;
      try {
        text = readFileSync(table, "utf8");
      } catch {
        continue;
      }
      sawAny = true;
      for (const line of text.split("\n").slice(1)) {
        const f = line.trim().split(/\s+/);
        // sl local_address rem_address st tx_queue… — local is HEXIP:HEXPORT
        if (f[3] === "0A" && Number.parseInt(f[1]?.split(":")[1] ?? "", 16) === port) return true;
      }
    }
    if (sawAny) return false; // tables readable and silent — genuinely nobody listens
  }
  const args = platform === "darwin" ? ["-an", "-p", "tcp"] : ["-tnl"];
  // `netstat` lives in /usr/sbin on macOS — and a THROWN spawnSync (the
  // binary simply is not on PATH, e.g. a GUI-launched CLI or `env -i`) never
  // reaches exitCode. Measured 2026-09-07: `status` exited 1 with ZERO output
  // on a Mac whose PATH lacked /usr/sbin. No netstat is no answer, not a
  // failed command.
  let out: string;
  try {
    const res = Bun.spawnSync({
      cmd: ["netstat", ...args],
      stdout: "pipe",
      stderr: "ignore",
      timeout: 1000,
      // `env` passed EXPLICITLY, and it is what makes the guard above real
      // rather than aspirational. Measured on bun 1.4.0: `Bun.spawnSync`
      // resolves the binary from a snapshot of the environment taken at
      // PROCESS START, so with `env` omitted a PATH that no longer holds
      // /usr/sbin is ignored — netstat is found and answers anyway. That is
      // why the regression test for the 2026-09-07 GUI-launched-CLI failure
      // could never reproduce it: mutating `process.env.PATH` changed nothing.
      // Passing the live `process.env` makes resolution honour the environment
      // this process is actually running under, which is the only version of
      // "no netstat on PATH" a caller can observe or a test can arrange.
      env: process.env,
    });
    if (res.exitCode !== 0) return null; // no netstat — no answer available
    out = res.stdout.toString();
  } catch {
    return null;
  }
  // Shared column layout on both spellings:
  //   Proto Recv-Q Send-Q Local-Address Foreign State  → f[3] local, f[5] LISTEN.
  // macOS separates the port with "." (127.0.0.1.3080), Linux with ":3080".
  for (const line of out.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6 || f[5] !== "LISTEN") continue;
    const local = f[3] ?? "";
    const sep = Math.max(local.lastIndexOf(":"), local.lastIndexOf("."));
    if (Number.parseInt(local.slice(sep + 1), 10) === port) return true;
  }
  return false;
}
