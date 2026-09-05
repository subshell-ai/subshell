import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { config } from "@dotenvx/dotenvx";
import {
  DEFAULT_DATABASE_PATH,
  defaultSubshellServerDataDir as sharedDefaultSubshellServerDataDir,
} from "@internal/subshell-protocol";
import { default as envVar } from "env-var";

// A missing .env is not an error: deployments (Docker, systemd, CI) inject
// real environment variables and ship no dotenv file — the host dev checkout
// is the only place one exists. Without the ignore, dotenvx logs
// MISSING_ENV_FILE and exits, crash-looping the container.
config({
  quiet: true,
  ignore: ["MISSING_ENV_FILE"],
});

const env = envVar.from(process.env, {}, () => {});

export const SERVER_PORT = env.get("SERVER_PORT").default("3080").asPortNumber();

export const HOST = env.get("HOST").default("127.0.0.1").asString();

/**
 * True when this process is running the test suite.
 *
 * `SUBSHELL_TEST_MODE` is set by `src/test-preload.ts`, which `bunfig.toml`
 * preloads before any other module — so the flag is already in place by the
 * time this file reads the environment. `NODE_ENV === "test"` is honoured as
 * well: Bun sets it for `bun test`, and the logger has always keyed off it.
 *
 * Nothing else may infer "we are testing" from the *absence* of a variable.
 * That was the old rule, and it made a developer's `.env` decide whether the
 * suite ran against their real database — see {@link DATABASE_PATH}.
 */
export const IS_TEST = process.env.NODE_ENV === "test" || env.get("SUBSHELL_TEST_MODE").default("false").asBool();

/**
 * A per-process temp database file, used for every test run.
 *
 * Formerly the URI string `file::memory:?cache=shared`, chosen so the app's
 * Kysely connection (`db/index.ts`) and better-auth's separate handle
 * (`auth/database.ts`) would address ONE shared-cache in-memory database
 * instead of two private `:memory:` ones. That is sound SQLite doctrine but
 * wrong about Bun: `new Database(...)` does not interpret SQLite URIs, so
 * every test process was creating a LITERAL FILE named
 * `file::memory:?cache=shared` in its CWD — contended by concurrent test
 * processes (SQLITE_BUSY wars), persistent across runs, and never
 * observable as empty.
 *
 * A real temp file keeps what actually mattered — one path string computed
 * once per process, read by both handles, which share it as an ordinary
 * WAL file database — while making each `bun test` invocation private to
 * itself. All test FILES inside one invocation still share this DB (same
 * process), so suites must not assume it starts empty.
 *
 * Cleanup lives in `src/test-preload.ts`, not here: `bun test` never fires
 * `process` exit/beforeExit listeners (verified empirically on Bun 1.4.0),
 * so an exit hook on this module would leak a file every run, while the
 * preload's `afterAll` runs after the last suite. It matches this file
 * name's `subshell-test-<pid>-` prefix instead of importing this constant,
 * because a static import would hoist above the preload's `SUBSHELL_TEST_MODE`
 * assignment — and the flag must be set before this module reads env.
 */
const TEST_DATABASE_PATH = join(tmpdir(), `subshell-test-${process.pid}-${randomUUID()}.db`);

/**
 * SQLite database file path (a directory is created if missing).
 *
 * Under {@link IS_TEST} this is forced to a per-process temp database file
 * (see {@link TEST_DATABASE_PATH}) and the environment is ignored outright. The override has to be unconditional: Bun
 * loads `.env` before the test preload runs, so a `DATABASE_PATH` line there
 * — the one `.env.example` ships, which every developer copies — is already
 * in `process.env` by then. Filling the value in only when absent therefore
 * pointed the suites at the developer's live database, where they create and
 * delete users, subshells and saved paths. That is a data-loss bug, not a
 * configuration preference, so there is no opt-out.
 */
export const DATABASE_PATH = IS_TEST
  ? TEST_DATABASE_PATH
  : env.get("DATABASE_PATH").default(DEFAULT_DATABASE_PATH).asString();

/**
 * Directory holding per-subshell output logs (see `subshellLogPath`).
 *
 * Defaults to the database file's own directory, so a normal deployment needs
 * no extra configuration — `DATABASE_PATH=/data/subshell.db` puts logs in
 * `/data/subshells/`. It stays separately overridable for the one case the
 * derived value cannot serve: an in-memory database has no directory to
 * derive from.
 *
 * Under {@link IS_TEST} it is a fresh temp directory and the environment is
 * ignored, for the same reason {@link DATABASE_PATH} is: `subshellLogPath`
 * writes real files, and deriving this from a configured path would drop test
 * logs into the developer's `data/subshells/`.
 *
 * The value is always resolved to an absolute path, even when configured
 * relative: it leaves this process as data the *harness* dereferences
 * (`--mcp-config <path>`, `SUBSHELL_DATA_DIR`) and as the target of tmux's
 * pipe-pane shell — all of which run under the subshell's working directory,
 * not the backend's. A relative `./data` made claude look for
 * `<subshell-cwd>/data/mcp/<id>.json`, which never exists, and every subshell
 * died at once with "MCP config file not found".
 */
export const SUBSHELL_SERVER_DATA_DIR = IS_TEST
  ? mkdtempSync(join(tmpdir(), "subshell-test-data-"))
  : resolve(env.get("SUBSHELL_SERVER_DATA_DIR").default(defaultSubshellServerDataDir()).asString());

/**
 * Days a terminated subshell's pane log is kept before the retention sweep
 * unlinks it (`services/pane-log-hygiene.ts`). `0` disables the sweep.
 *
 * A pane log is the verbatim transcript of a session — typed secrets and all —
 * and before this existed it was unlinked only when the subshell was DELETED,
 * so a terminated-but-kept subshell held its transcript forever. The default
 * is a compromise: long enough that "what did that agent do last week?" is
 * still answerable, short enough that the plaintext does not accumulate for
 * the life of the instance. Running subshells are never swept.
 */
export const DEFAULT_LOG_RETENTION_DAYS = 30;

/** Configured retention window; see {@link DEFAULT_LOG_RETENTION_DAYS}. */
// `asInt`, not `asIntPositive`: 0 is the documented opt-out and would be
// rejected as non-positive. The sweep treats anything <= 0 as keep-forever.
export const SUBSHELL_LOG_RETENTION_DAYS = env
  .get("SUBSHELL_LOG_RETENTION_DAYS")
  .default(DEFAULT_LOG_RETENTION_DAYS)
  .asInt();

/**
 * Directory `GET /api/downloads/node/*` serves the prebuilt `subshell`
 * binaries from (spec 2026-08-31 §8): files named `subshell-<target>`
 * (plus an optional `subshell-<target>.sha256` sidecar). The build pipeline
 * that populates it is separate (e2e Task 16) — serving a directory that does
 * not exist yet is a plain 404, so no boot check.
 *
 * Under {@link IS_TEST} it hangs off the temp {@link SUBSHELL_SERVER_DATA_DIR} (the
 * environment is ignored, same reasoning as there), which lets route tests
 * write fixtures straight into it.
 */
export const NODE_ARTIFACTS_DIR = IS_TEST
  ? join(SUBSHELL_SERVER_DATA_DIR, "node-artifacts")
  : resolve(
      env.get("SUBSHELL_NODE_ARTIFACTS_DIR").default(join(SUBSHELL_SERVER_DATA_DIR, "node-artifacts")).asString(),
    );

/**
 * The database file's directory, or `./data` when the path is not file-backed
 * (an in-memory database or a SQLite URI has no meaningful dirname). The rule
 * itself lives in `@internal/subshell-protocol` (paths.ts) because the agent's
 * release pipeline must derive the SAME node-artifacts default — the ladder
 * is a cross-process contract, not a backend secret.
 */
function defaultSubshellServerDataDir(): string {
  return sharedDefaultSubshellServerDataDir({ DATABASE_PATH: process.env.DATABASE_PATH });
}

/**
 * Base URL used for auth cookies / redirects, e.g. http://localhost:3080.
 * Defaults to the port this process actually binds (SERVER_PORT), not the
 * baked-in 3080 — a relocated instance whose base URL lies gets its own
 * redirects and `subshell mcp` callbacks pointed at a dead port.
 *
 * Forced to the loopback default under {@link IS_TEST}: better-auth keys the
 * session cookie NAME off this URL's protocol (`__Secure-` prefix under
 * https), so a developer's `.env` with a proxied https base URL would
 * silently flip cookie semantics for the whole suite — the same class of
 * leak {@link DATABASE_PATH} closed for the database.
 */
export const APP_BASE_URL = IS_TEST
  ? `http://localhost:${SERVER_PORT}`
  : env.get("APP_BASE_URL").default(`http://localhost:${SERVER_PORT}`).asString();

/**
 * The baked-in fallback for {@link AUTH_SECRET}. Public by definition (it is
 * in the repo), so it must never be the secret a production instance signs
 * cookies with — see {@link assertProdAuthSecret}.
 */
export const PLACEHOLDER_AUTH_SECRET = "dev-secret-do-not-use-in-prod-0123456789";

/** better-auth secret used to sign session cookies (>= 32 chars in prod). */
export const AUTH_SECRET = env.get("BETTER_AUTH_SECRET").default(PLACEHOLDER_AUTH_SECRET).asString();

/**
 * Break-glass admin password (spec 2026-08-31 §6). Empty/absent ⇒ the hatch
 * is disarmed and sign-in behaves normally.
 *
 * A live read (function, not a module constant) on purpose: tests arm and
 * disarm between cases, and an operator flipping the var needs only the
 * restart they were going to do anyway. The banner (via the public-settings
 * flag) is the guard — this is an operator feature, so no prod boot-guard.
 */
export function emergencyPassword(): string {
  return process.env.SUBSHELL_EMERGENCY_PASSWORD ?? "";
}

/**
 * True while the break-glass hatch should be live. Whitespace-only values do
 * NOT arm it — a `" "` emergency password is no password (code-review
 * 2026-08-31 minor). The comparison itself always uses the raw {@link
 * emergencyPassword} value; this gate only decides whether it is consulted.
 */
export function emergencyLoginArmed(): boolean {
  return emergencyPassword().trim() !== "";
}

/**
 * The origins this instance serves itself on: both loopback spellings of the
 * port, the bind host when it is a concrete address, and the base URL's own
 * origin (a proxied/relocated deployment names itself there).
 *
 * Wildcard bind hosts are skipped — `0.0.0.0`/`::` are listen addresses, not
 * addresses anyone visits. An IPv6 host is bracketed as URL syntax requires.
 * @internal exported for the unit test; {@link TRUSTED_ORIGINS} is the value in use
 */
export function localOriginsFor(port: number, host: string, baseUrl?: string): string[] {
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const list = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  if (bracketed && bracketed !== "0.0.0.0" && bracketed !== "[::]" && bracketed !== "::" && bracketed !== "*") {
    list.push(`http://${bracketed}:${port}`);
  }
  if (baseUrl) {
    try {
      list.push(new URL(baseUrl).origin);
    } catch {
      // A malformed APP_BASE_URL is not worth a boot failure over; the
      // explicit TRUSTED_ORIGINS list still applies.
    }
  }
  // Deduped here because HOST is usually one of the loopback spellings, and a
  // duplicate would just echo through the final list.
  return [...new Set(list)];
}

/**
 * Origins better-auth accepts on credentialed auth requests (and the CORS
 * plugin allows). better-auth always trusts its own baseURL too, but that is
 * ONE spelling: the app binds `127.0.0.1` by default while the base URL says
 * `localhost`, so a browser pointed at the address the boot log prints
 * (http://127.0.0.1:3080) sent an origin nothing matched and first-run setup
 * died on 403 "Invalid origin". The list is therefore DERIVED from this
 * instance's own address (see {@link localOriginsFor}) and then extended with
 * `TRUSTED_ORIGINS` (comma-separated) — in dev that is the Vite server, whose
 * port the drift guard in `__tests__/trusted-origins.test.ts` keeps in sync
 * with apps/frontend/vite.config.ts.
 *
 * Deliberately absent: "trust any origin equal to the request host". That is
 * the DNS-rebinding hole a static allowlist exists to close
 * (.claude/rules/security-context.md) — a foreign hostname resolving to
 * 127.0.0.1 must stay untrusted, so extra names belong in TRUSTED_ORIGINS.
 */
export const TRUSTED_ORIGINS = [
  ...new Set([
    ...localOriginsFor(SERVER_PORT, HOST, APP_BASE_URL),
    ...env
      .get("TRUSTED_ORIGINS")
      .default("http://localhost:5174,http://localhost:5173")
      .asArray(",")
      .map((o) => o.trim()),
  ]),
].filter(Boolean);

export const IS_PROD = process.env.NODE_ENV === "production";
export const BACKEND_LOG_LEVEL = env.get("BACKEND_LOG_LEVEL").default("debug").asString();

/**
 * Trailing lines of a subshell's log that the terminal WS replays on attach
 * before switching to the live tail. Long subshells used to ship their ENTIRE
 * pipe-pane log into every attach, so the terminal took minutes to open.
 * Hard-capped at 200 — the setting exists to bound load time, not to
 * re-enable the full history. Garbage/unset values fall back to 100.
 *
 * Env: `SUBSHELL_TERMINAL_REPLAY_LINES` (default 100).
 */
export const TERMINAL_REPLAY_LINES = (() => {
  const raw = Number.parseInt(env.get("SUBSHELL_TERMINAL_REPLAY_LINES").default("100").asString(), 10);
  if (!Number.isFinite(raw) || raw < 1) return 100;
  return Math.min(200, raw);
})();

/**
 * Hard-fails a production boot that would sign session cookies with the
 * placeholder secret.
 *
 * better-auth 1.7.1's own prod guard only rejects ITS default string
 * (`node_modules/better-auth/dist/context/create-context.mjs`), so an unset
 * `BETTER_AUTH_SECRET` under `NODE_ENV=production` would otherwise boot
 * silently and mint cookies signed with a publicly known, in-repo key —
 * trivially forged admin subshells. Called first in `src/index.ts`, i.e. on
 * every production surface: `bun run prod` and the compiled binary alike.
 *
 * Dev and test (`IS_TEST` ⇒ `NODE_ENV !== "production"`) keep the placeholder
 * default untouched.
 *
 * @param isProd - production flag; defaults to {@link IS_PROD}
 * @param secret - the resolved secret; defaults to {@link AUTH_SECRET}
 * @throws when both are (production, placeholder)
 */
export function assertProdAuthSecret(isProd: boolean = IS_PROD, secret: string = AUTH_SECRET): void {
  if (isProd && secret === PLACEHOLDER_AUTH_SECRET) {
    throw new Error(
      "Refusing to boot: BETTER_AUTH_SECRET is unset in production. The built-in placeholder secret is public " +
        "(it ships in the repo), so session cookies signed with it can be forged by anyone. " +
        "Set BETTER_AUTH_SECRET to a unique value of at least 32 characters.",
    );
  }
}
