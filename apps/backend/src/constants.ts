import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { config } from "@dotenvx/dotenvx";
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
 * `MOTE_TEST_MODE` is set by `src/test-preload.ts`, which `bunfig.toml`
 * preloads before any other module — so the flag is already in place by the
 * time this file reads the environment. `NODE_ENV === "test"` is honoured as
 * well: Bun sets it for `bun test`, and the logger has always keyed off it.
 *
 * Nothing else may infer "we are testing" from the *absence* of a variable.
 * That was the old rule, and it made a developer's `.env` decide whether the
 * suite ran against their real database — see {@link DATABASE_PATH}.
 */
export const IS_TEST = process.env.NODE_ENV === "test" || env.get("MOTE_TEST_MODE").default("false").asBool();

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
 * name's `mote-test-<pid>-` prefix instead of importing this constant,
 * because a static import would hoist above the preload's `MOTE_TEST_MODE`
 * assignment — and the flag must be set before this module reads env.
 */
const TEST_DATABASE_PATH = join(tmpdir(), `mote-test-${process.pid}-${randomUUID()}.db`);

/**
 * SQLite database file path (a directory is created if missing).
 *
 * Under {@link IS_TEST} this is forced to a per-process temp database file
 * (see {@link TEST_DATABASE_PATH}) and the environment is ignored outright. The override has to be unconditional: Bun
 * loads `.env` before the test preload runs, so a `DATABASE_PATH` line there
 * — the one `.env.example` ships, which every developer copies — is already
 * in `process.env` by then. Filling the value in only when absent therefore
 * pointed the suites at the developer's live database, where they create and
 * delete users, sessions and saved paths. That is a data-loss bug, not a
 * configuration preference, so there is no opt-out.
 */
export const DATABASE_PATH = IS_TEST
  ? TEST_DATABASE_PATH
  : env.get("DATABASE_PATH").default("./data/mote.db").asString();

/**
 * Directory holding per-session output logs (see `sessionLogPath`).
 *
 * Defaults to the database file's own directory, so a normal deployment needs
 * no extra configuration — `DATABASE_PATH=/data/mote.db` puts logs in
 * `/data/sessions/`. It stays separately overridable for the one case the
 * derived value cannot serve: an in-memory database has no directory to
 * derive from.
 *
 * Under {@link IS_TEST} it is a fresh temp directory and the environment is
 * ignored, for the same reason {@link DATABASE_PATH} is: `sessionLogPath`
 * writes real files, and deriving this from a configured path would drop test
 * logs into the developer's `data/sessions/`.
 *
 * The value is always resolved to an absolute path, even when configured
 * relative: it leaves this process as data the *harness* dereferences
 * (`--mcp-config <path>`, `MOTE_DATA_DIR`) and as the target of tmux's
 * pipe-pane shell — all of which run under the session's working directory,
 * not the backend's. A relative `./data` made claude look for
 * `<session-cwd>/data/mcp/<id>.json`, which never exists, and every session
 * died at once with "MCP config file not found".
 */
export const SESSION_DATA_DIR = IS_TEST
  ? mkdtempSync(join(tmpdir(), "mote-test-data-"))
  : resolve(env.get("SESSION_DATA_DIR").default(defaultSessionDataDir()).asString());

/**
 * The database file's directory, or `./data` when the path is not file-backed
 * (an in-memory database or a SQLite URI has no meaningful dirname).
 */
function defaultSessionDataDir(): string {
  const raw = env.get("DATABASE_PATH").default("./data/mote.db").asString();
  if (raw.startsWith("file:") || raw.includes(":memory:") || !raw.includes("/")) return "./data";
  return raw.slice(0, Math.max(0, raw.lastIndexOf("/"))) || ".";
}

/**
 * Base URL used for auth cookies / redirects, e.g. http://localhost:3080.
 * Defaults to the port this process actually binds (SERVER_PORT), not the
 * baked-in 3080 — a relocated instance whose base URL lies gets its own
 * redirects and `mote mcp` callbacks pointed at a dead port.
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
  return process.env.MOTE_EMERGENCY_PASSWORD ?? "";
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
 * Hard-fails a production boot that would sign session cookies with the
 * placeholder secret.
 *
 * better-auth 1.7.1's own prod guard only rejects ITS default string
 * (`node_modules/better-auth/dist/context/create-context.mjs`), so an unset
 * `BETTER_AUTH_SECRET` under `NODE_ENV=production` would otherwise boot
 * silently and mint cookies signed with a publicly known, in-repo key —
 * trivially forged admin sessions. Called first in `src/index.ts`, i.e. on
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
