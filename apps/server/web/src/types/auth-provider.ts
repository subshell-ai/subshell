/**
 * The SPA's mirror of `GET /api/auth-providers` (spec 2026-09-24 §7/§8).
 * Hand-typed like every other `types/` file here: the wire is the contract,
 * and the route that serves it is Task 8's, not this bundle's.
 */

/** The three door kinds; `email` is the reserved credential row (§2). */
export type AuthProviderKind = "email" | "google" | "oidc";

/** The reserved row's id — it renders in the table but has no edit dialog. */
export const EMAIL_PROVIDER_ID = "email";

/**
 * The Google preset's issuer. The dialog prefills it so the admin registers a
 * plain OIDC app against Google's discovery document without pasting the URL
 * (spec §5a: it is the one issuer worth knowing by heart).
 */
export const GOOGLE_ISSUER = "https://accounts.google.com";

/** One rendering of `kind` for the badges, so rows cannot spell it apart. The
 * dialog's kind Select names its options itself: "Generic OIDC" there is the
 * choice being made, not a second spelling of the badge word. */
export const KIND_LABELS: Record<AuthProviderKind, string> = {
  email: "Email",
  google: "Google",
  oidc: "OIDC",
};

/**
 * One provider row as the admin list serves it. The secret is NOT here — the
 * route serializes `hasSecret` instead (spec §8: "secrets never serialized"),
 * and the edit dialog re-enters it.
 */
export interface ProviderAdminView {
  /** The id slug: path element of the callback URL, immutable after create */
  id: string;
  kind: AuthProviderKind;
  /** Display name the admin chose */
  name: string;
  /** OIDC issuer URL; null only on the `email` row */
  issuer: string | null;
  /** OAuth client id; null only on the `email` row */
  clientId: string | null;
  /** Whether a client secret is stored (never the secret itself) */
  hasSecret: boolean;
  /** Entry origins, position 0 canonical (§5a); empty only on the `email` row */
  entryOrigins: string[];
  /** Allowed email domains, empty/null = any (§5); normalized server-side */
  allowedDomains: string[] | null;
  /** Master switch: an unchecked door does nothing, however open its half-switches are */
  enabled: boolean;
  signInEnabled: boolean;
  /**
   * Null ONLY on the `email` row, meaning the legacy dynamic gate: open while
   * nobody has registered yet (`registrationDisplay` renders that state).
   */
  registrationEnabled: boolean | null;
  requireApproval: boolean;
  /** Whether discovery endpoints were resolved at save (badge-only, §7) */
  endpointsResolved: boolean;
}

/** Body of `POST /api/auth-providers`. The `id` is the dialog's slug preview,
 * sent so the registration-info panel's prediction is the stored truth (§5a). */
export interface CreateAuthProviderBody {
  id: string;
  kind: "google" | "oidc";
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  entryOrigins: string[];
  /** Comma-separated; the route normalizes, empty means any domain */
  allowedDomains?: string;
  enabled: boolean;
  signInEnabled: boolean;
  registrationEnabled: boolean;
  requireApproval: boolean;
}

/** Body of `PATCH /api/auth-providers/:id` — a partial of the create body;
 * `id`/`kind` are immutable and never sent. */
export type PatchAuthProviderBody = Partial<Omit<CreateAuthProviderBody, "id" | "kind">>;

/** Result of `POST /api/auth-providers/test` (§8). */
export interface TestProviderResult {
  ok: boolean;
  endpoints?: { authorizationUrl: string; tokenUrl: string; userInfoUrl: string | null };
  /** The soft signal when the token-endpoint grant is not offered (Google) */
  note?: string;
}

/**
 * The exact Redirect URI the IdP registration needs for this entry origin
 * (spec §5a). Byte-for-byte the stored origin plus the fixed callback path —
 * the same string the round trip sends, and the one thing the admin pastes.
 */
export function callbackUrlFor(origin: string, id: string): string {
  return `${origin}/api/auth/callback/${id}`;
}

/** How the Registration column renders one row. */
export interface RegistrationDisplay {
  /** Switch state */
  checked: boolean;
  /** The word beside it; the null gate's sentence names the mechanism, not a fake state */
  label: string;
  /** True when a null email-row flag is answering with the computed gate */
  computed: boolean;
}

/**
 * The Registration cell's answer for one row. The email row's `null` is not
 * "closed" and not "open" — it is the legacy dynamic gate, and its computed
 * decision (`allowRegistrations` from the settings read) decides BOTH the
 * switch and the sentence beside it: a gate the instance has already closed
 * must not read as open.
 */
export function registrationDisplay(row: ProviderAdminView, computedOpen: boolean): RegistrationDisplay {
  if (row.registrationEnabled === null) {
    return {
      checked: computedOpen,
      label: computedOpen ? "Open until someone registers" : "Automatically closed once the first account signed up",
      computed: true,
    };
  }
  return {
    checked: row.registrationEnabled,
    label: row.registrationEnabled ? "Open" : "Closed",
    computed: false,
  };
}

/**
 * The dialog's live preview of the id the server will give a new provider.
 * A mirror of the route's `slugifyProviderId` (lowercase, `[a-z0-9-]`, runs
 * collapsed, ≤ 40 chars — spec §2); the create body sends it, so what the
 * copy panel showed is byte-identically what gets stored.
 */
export function previewProviderId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
