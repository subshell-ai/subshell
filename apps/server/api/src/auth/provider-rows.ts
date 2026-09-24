import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { GenericOAuthConfig } from "better-auth/plugins";
import { DATABASE_PATH } from "@/constants.js";
import { type AuthProviderKind, asProviderKind } from "@/db/types/auth-providers.db-types.js";
import { logger } from "@/utils/logger.js";

/** The discovery-resolved endpoints captured at save time (§3). */
export interface StoredEndpoints {
  /** Authorization endpoint, resolved from discovery when the door was saved. */
  authorizationUrl: string;
  /** Token endpoint, resolved from discovery when the door was saved. */
  tokenUrl: string;
  /** UserInfo endpoint; null when the door's discovery had none. */
  userInfoUrl: string | null;
}

/**
 * The build-time shape of one door. DB rows arrive as `AuthProviderRow`
 * (raw integers and JSON text); this is the parsed form every consumer reads,
 * so the coercion happens exactly once. Corrupt JSON throws inside the
 * loader's per-row guard — the row is skipped with a warn (spec §3's
 * fail-tolerant rule): a junk column costs one door, not the auth instance.
 */
export interface StoredProviderRow {
  /** Door id; also the genericOAuth `providerId` and the callback path segment. */
  id: string;
  /** Credential family, narrowed from the text column by `asProviderKind`. */
  kind: AuthProviderKind;
  /** Display name shown on the sign-in page. */
  name: string;
  /** OIDC issuer; becomes the config's `accountIssuer` (null = none stored). */
  issuer: string | null;
  /** OAuth client id (null only on malformed/hand-edited rows; config gets ""). */
  clientId: string | null;
  /** OAuth client secret; null means the door authenticates without one. */
  clientSecret: string | null;
  /** Endpoints captured at save time; null when the door was saved without them (§3: rebuilds never re-fetch discovery). */
  endpoints: StoredEndpoints | null;
  /** Entry origins from the stored list; position 0 is canonical (§5a). */
  entryOrigins: string[];
  /** Allowed e-mail domains; empty list = any domain (§5). */
  allowedDomains: string[];
  /** Whether this door may sign in at all. */
  signInEnabled: boolean;
  /** Read by the door policy's registration case, never mapped to `disableSignUp` (finding F1: the belt short-circuited the create path before the hook could answer `registration_closed`); NULL is the legacy dynamic gate, legal on the email row only (§2). */
  registrationEnabled: boolean | null;
  /** Whether accounts this door creates land on "pending" (§6). */
  requireApproval: boolean;
}

/**
 * The synchronous door read: the auth build (`buildAuth`) and, from Task 5,
 * the door policy — ONE reader shape for both, so the configuration a sign-in
 * is refused under is always the configuration that was built.
 *
 * It opens its OWN short-lived bun:sqlite connection because it must run
 * inside `betterAuth()` construction synchronously, where the app's Kysely
 * handle (async-only at the query boundary) cannot be awaited. Raw SQL, so
 * physical snake_case names are spelled directly (the CamelCasePlugin rule).
 * The WHERE is a door's purpose: enabled, and either sign-in-able or holding
 * an explicit registration decision; ORDER BY position is what makes row
 * order — and so canonical origin — stable.
 *
 * Readonly first, and a write-capable reopen (`create: false`, still writes
 * nothing — the only statements here are SELECTs) on ANY failure: the same
 * ladder `commands/status.ts` counts users with, because SQLite cannot read
 * a WAL database whose `-shm` sidecar is gone (a restored backup, a cleanly
 * closed copy) — the readonly open SUCCEEDS there and the first query throws,
 * so a single readonly attempt would report a readable database as broken.
 * Both opens failing is a genuinely unreadable database: throw, and let
 * `getAuth()`'s last-known-good rule decide what that costs.
 */
export function loadProviderRowsSync(path: string = DATABASE_PATH): StoredProviderRow[] {
  // No database file yet — a cold scratch DB, or `:memory:`, which Bun opens
  // as a fresh handle rather than a path — is a database with ZERO doors, not
  // an unreadable one: the auth build creates the file right after this read,
  // and "no doors configured" is the honest answer for a file that does not
  // exist. (An EXISTING but unreadable file still throws, below.)
  if (!existsSync(path)) return [];
  const rows = selectDoors(path, { readonly: true }) ?? selectDoors(path, { readwrite: true, create: false });
  if (!rows) {
    throw new Error(`could not read auth_providers from ${path}`);
  }
  return rows.flatMap((raw) => {
    try {
      return [shapeRow(raw)];
    } catch (err) {
      logger.withError(err).warn(`auth_providers row ${String(raw.id)} is unusable and was skipped`);
      return [];
    }
  });
}

const DOOR_QUERY = `
  SELECT id, kind, name, issuer, client_id, client_secret, endpoints_json,
         entry_origins, allowed_domains, enabled, sign_in_enabled,
         registration_enabled, require_approval
  FROM auth_providers
  WHERE enabled = 1 AND (sign_in_enabled = 1 OR registration_enabled IS NOT NULL)
  ORDER BY position, id
`;

function selectDoors(
  path: string,
  mode: { readonly: true } | { readwrite: true; create: false },
): Record<string, unknown>[] | null {
  let db: Database | undefined;
  try {
    db = new Database(path, mode);
    // A database where `auth_providers` was never created (app migrations not
    // run yet) is a READABLE database with ZERO doors, not a broken one — an
    // email-only instance is the legal pre-door state, and the probe shape is
    // `commands/status.ts`'s: an absent table must never read as corruption.
    if (!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_providers'`).get()) return [];
    return db.query<Record<string, unknown>, never[]>(DOOR_QUERY).all();
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // A handle that would not close is not a reason to fail a read.
    }
  }
}

/** Coerce one raw row. Throws on anything unshapable — the loader turns that into a skip. */
function shapeRow(raw: Record<string, unknown>): StoredProviderRow {
  return {
    id: text(raw.id),
    kind: asProviderKind(optText(raw.kind)),
    name: text(raw.name),
    issuer: optText(raw.issuer),
    clientId: optText(raw.client_id),
    clientSecret: optText(raw.client_secret),
    endpoints: parseEndpoints(raw.endpoints_json),
    entryOrigins: parseJsonArray(raw.entry_origins),
    allowedDomains: splitDomains(raw.allowed_domains),
    signInEnabled: raw.sign_in_enabled === 1,
    // NULL stays NULL: it is the legacy dynamic gate's meaning (§2), and
    // collapsing it to a boolean would invent a policy nobody wrote.
    registrationEnabled:
      raw.registration_enabled === undefined || raw.registration_enabled === null
        ? null
        : raw.registration_enabled === 1,
    requireApproval: raw.require_approval === 1,
  };
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("required text column read as non-text");
  return value;
}

function optText(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

function parseEndpoints(raw: unknown): StoredEndpoints | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const parsed = JSON.parse(String(raw)) as unknown;
  if (typeof parsed !== "object" || parsed === null) throw new Error("endpoints_json: expected an object");
  const o = parsed as Record<string, unknown>;
  // A door whose saved endpoints lack the two REQUIRED URLs cannot be built;
  // the endpoint pair is exactly what makes re-fetching discovery unnecessary.
  return {
    authorizationUrl: text(o.authorizationUrl),
    tokenUrl: text(o.tokenUrl),
    userInfoUrl: optText(o.userInfoUrl),
  };
}

function parseJsonArray(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === "") return [];
  const parsed = JSON.parse(String(raw)) as unknown;
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "string")) {
    throw new Error("entry_origins: expected a string array");
  }
  return parsed;
}

function splitDomains(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === "") return [];
  return String(raw)
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d !== "");
}

/**
 * One door's genericOAuth config (measured member set, 1.7.1): explicit
 * endpoints + accountIssuer so plugin init NEVER fetches discovery — the
 * failure mode that otherwise throws at build and, since AUTH_OPTIONS feeds
 * `runAuthMigrations`, crash-loops boot (spec §3). Explicit endpoints are
 * also what a rebuild runs on when the issuer is briefly dead: the table
 * holds the URLs resolved at save time, so no rebuild re-walks the network.
 * `redirectURI` is always `${canonicalOrigin}/api/auth/callback/${id}` with
 * the origin supplied by the caller from the STORED list (never the request).
 */
export function toGenericOAuthConfig(row: StoredProviderRow, canonicalOrigin: string): GenericOAuthConfig {
  return {
    providerId: row.id,
    name: row.name, // measured: GenericOAuthConfig spells the display name `name`
    clientId: row.clientId ?? "",
    clientSecret: row.clientSecret ?? undefined,
    accountIssuer: row.issuer ?? undefined,
    ...(row.endpoints && {
      authorizationUrl: row.endpoints.authorizationUrl,
      tokenUrl: row.endpoints.tokenUrl,
      // The config member is `string | undefined`; null means "absent".
      ...(row.endpoints.userInfoUrl !== null && { userInfoUrl: row.endpoints.userInfoUrl }),
    }),
    redirectURI: `${canonicalOrigin}/api/auth/callback/${row.id}`,
    scopes: ["openid", "email", "profile"],
    // `disableSignUp` is deliberately NOT set from registrationEnabled, and
    // that is a MEASURED decision (spec 2026-09-24 §4, Task 7 finding): the
    // callback's create path checks the config flag BEFORE it reaches
    // internalAdapter.createUser, so a config-level belt would answer
    // `signup_disabled` — a code the login page does not map — and the door
    // policy's `registration_closed` (§4's named refusal) would never reach
    // the browser. The one seam the spec puts per-door registration on is
    // `user.validateUserInfo` (`door-policy.ts`), and it fires on every path
    // that could create a user.
    mapProfileToUser: (p) => ({
      // §5: the provider's verified claim, never the mere presence of an email.
      email: String(p.email ?? ""),
      emailVerified: p.email_verified === true,
      name: typeof p.name === "string" && p.name !== "" ? p.name : undefined,
      image: typeof p.image === "string" ? p.image : undefined,
    }),
  };
}

/**
 * Which entry origin a round trip should use: exact membership, else
 * canonical (§5a). Request input is matched, never spliced.
 */
export function pickEntryOrigin(entryOrigins: string[], visitorOrigin: string | null, fallback: string): string {
  if (visitorOrigin !== null && entryOrigins.includes(visitorOrigin)) return visitorOrigin;
  return fallback;
}
