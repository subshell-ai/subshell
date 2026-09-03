import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { sql } from "kysely";
import { authDatabase } from "@/auth/database.js";
import { APP_BASE_URL, AUTH_SECRET, TRUSTED_ORIGINS } from "@/constants.js";
import { ensureDefaultProfilesForUser } from "@/services/default-profiles.js";
import { logger } from "@/utils/logger.js";

/**
 * The raw better-auth options, exported for `runAuthMigrations`:
 * `getMigrations` must receive the FULL options (plugins included) to create
 * plugin-owned tables like `apikey` — passing only `{ database }` silently
 * skips them.
 *
 * The auth database is the same bun:sqlite file as the app (better-auth's
 * bundled dialect handles it). Roles do NOT live on the better-auth user;
 * they live in the app's `user_meta` table via the databaseHooks below.
 */
export const AUTH_OPTIONS = {
  baseURL: APP_BASE_URL,
  secret: AUTH_SECRET,
  // NOTE (plan 2 CLI hygiene audit): this calls `authDatabase()` at import
  // time (better-auth opens the handle inside its constructor, so a lazy
  // getter defers nothing). That is fine because the CLI path
  // (`cli-bootstrap.ts`) exits SYNCHRONOUSLY inside `dispatchCli` and never
  // evaluates this module; do not import `@/auth.js` from anything the CLI
  // graph touches.
  database: authDatabase(),
  emailAndPassword: {
    enabled: true,
  },
  trustedOrigins: TRUSTED_ORIGINS,
  session: {
    // Deliberately short (security audit 2026-08, F5): cookieCache lets
    // better-auth answer its own session endpoints (sign-out freshness,
    // requireSession inside better-auth plugins) from a client-held cookie
    // for up to `maxAge` seconds WITHOUT a DB read — so a copied or stale
    // cookie jar kept passing those endpoints for up to 7 days after
    // sign-out. 5 minutes bounds that revocation window. App routes never
    // depended on this cache: `authGuard` feeds only the session_token to
    // `auth.api.getSession`, which is DB-backed every request, so route
    // freshness is unchanged.
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes in seconds
    },
  },
  advanced: {
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax" as const, // literal kept: AUTH_OPTIONS leaves the inline-literal typing context
    },
  },
  // API keys for machine access (MCP bearer tokens + admin-managed system
  // keys). Rate limiting is off: subshells long-poll channel reads and would
  // trip per-minute request ceilings for no protective benefit on a local
  // service (keys themselves are the credential boundary).
  plugins: [
    apiKey({
      enableMetadata: true,
      requireName: true,
      // Session token names are "sess:<uuid>" (41 chars); default cap is 32.
      maximumNameLength: 64,
      defaultPrefix: "subshell_",
      rateLimit: { enabled: false },
    }),
    // Passkeys (spec 2026-08-31): additional browser credential, never a
    // second factor. rpID is deliberately unset — better-auth 1.7.1 derives
    // it from the CONFIGURED baseURL (options.rpID || new URL(baseURL)
    // .hostname, passkey dist index.mjs:13), NEVER the request host. So
    // passkeys bind to the instance's canonical address (APP_BASE_URL's
    // host): browsing from any other name — loopback against a
    // domain-configured instance, or a relocated host — fails WebAuthn
    // validation in the browser before reaching the server. Pinned by the
    // rp.id assertion in passkey-plugin.test.ts; the UI copy says the same.
    // origin unset likewise: the client supplies it (1.7.1 documented default).
    passkey({ rpName: "subshell" }),
  ],
  databaseHooks: {
    user: {
      create: {
        before: async () => {
          // Registration gate: once the app is set up, the admin can close it.
          if (!(await registrationAllowed())) {
            return false;
          }
          return undefined;
        },
        after: async (createdUser) => {
          await promoteFirstUserToAdmin(createdUser.id);
          // A new user must be able to open a session without first filling a
          // profile form: seed a blank Default for each enabled harness.
          // Idempotent and never overwrites (insert-only when a pair has zero
          // profiles) — see services/default-profiles.ts. Guarded like the
          // promotion above it: without the injected policy DB there is nothing
          // to seed into, and registration still succeeds. BEST-EFFORT for the
          // same reason: the user row is already committed, so a seeding
          // failure (e.g. SQLITE_BUSY) must not turn sign-up into a 500 — the
          // account exists and a retry would hit "email already in use". The
          // boot sweep heals the gap; log so it is diagnosable meanwhile.
          if (appDb) {
            await ensureDefaultProfilesForUser(appDb, createdUser.id).catch((err) => {
              logger.withError(err).warn(`default-profile seeding failed for user ${createdUser.id}`);
            });
          }
        },
      },
    },
  },
};

/** Builds the better-auth instance. Its constructor OPENS SQLite — so this
 *  never runs at module evaluation (import-purity invariant, spec 2026-09-03):
 *  the entry graph must stay IO-free for the `mcp` subcommand's lifetime. */
function buildAuth() {
  return betterAuth(AUTH_OPTIONS);
}

type Auth = ReturnType<typeof buildAuth>;
let instance: Auth | undefined;

/**
 * The better-auth instance (singleton per the code-style rule), built on
 * FIRST USE. Everything that needs auth does so at boot or per-request —
 * both well after module evaluation — so the laziness is invisible in
 * behavior and visible only in the absence of import-time side effects.
 */
export function getAuth(): Auth {
  instance ??= buildAuth();
  return instance;
}

/**
 * Drops the memoized instance. Only for tests that need a fresh build.
 * @internal
 */
export function resetAuthForTests(): void {
  instance = undefined;
}

let appDb: import("kysely").Kysely<import("@/db/types/index.js").Database> | undefined;

/** Injected by the app bootstrap so auth policy can read app settings. */
export function setAuthPolicyDb(db: import("kysely").Kysely<import("@/db/types/index.js").Database>): void {
  appDb = db;
}

/**
 * Reads the registration gate setting.
 *
 * Semantics (security audit 2026-08, F6a) — the gate FAILS CLOSED:
 * - missing row → open (the pre-setup default: the boot wizard must work);
 * - parseable JSON `true` → open;
 * - anything else (explicit `false`, an unparseable/corrupted value, a
 *   non-boolean document) → closed. The old code treated unparseable as
 *   open, which turned a settings-row corruption into silently re-opened
 *   registration on a locked-down instance.
 */
async function registrationAllowed(): Promise<boolean> {
  if (!appDb) return true;
  const row = await appDb
    .selectFrom("settings")
    .select("value")
    .where("key", "=", "allow_registrations")
    .executeTakeFirst();
  if (!row) return true;
  try {
    return (JSON.parse(row.value) as unknown) === true;
  } catch {
    return false;
  }
}

/**
 * The first user ever registered becomes admin; everyone else lands on
 * "user". Roles live in `user_meta` (separate from the auth user table).
 *
 * ONE atomic statement (security audit 2026-08, F6b): the old count-then-
 * insert let two concurrent first sign-ups both read zero and both mint
 * admin, and its `onConflict doUpdateSet({ role })` could afterwards flip a
 * winner back to loser. Here the emptiness test lives inside the INSERT
 * itself (`CASE WHEN NOT EXISTS (…)`), which SQLite evaluates under the
 * write lock — the second concurrent caller necessarily sees the winner's
 * row and lands on 'user'. Documented loser semantics: it gets its own row
 * with role 'user'; re-running for an existing user is a no-op
 * (`ON CONFLICT DO NOTHING`), so a role is never overwritten here.
 *
 * Exported for the concurrency test, which runs it against a private
 * scratch database (the shared test DB can never be observed empty).
 *
 * @param db - the app database to promote within
 * @param userId - the newly created user's id
 */
export async function promoteFirstUserAtomically(
  db: import("kysely").Kysely<import("@/db/types/index.js").Database>,
  userId: string,
): Promise<void> {
  // Raw SQL on purpose: physical snake_case names, and the emptiness probe
  // must sit inside the INSERT statement (a builder `.select()` subquery for
  // this shape only re-introduces noise). CamelCasePlugin leaves snake_case
  // text untouched.
  await sql`
    INSERT INTO user_meta (user_id, role)
    SELECT ${userId},
           CASE WHEN NOT EXISTS (SELECT 1 FROM user_meta) THEN 'admin' ELSE 'user' END
    ON CONFLICT (user_id) DO NOTHING
  `.execute(db);
}

/** The `databaseHooks` entry point: promote on the injected app database. */
async function promoteFirstUserToAdmin(userId: string): Promise<void> {
  if (!appDb) return;
  await promoteFirstUserAtomically(appDb, userId);
}
