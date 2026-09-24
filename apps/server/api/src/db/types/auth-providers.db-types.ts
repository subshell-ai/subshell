import type { Generated, Selectable } from "kysely";

/** Auth door kind; "email" is the reserved credential-provider row (§2). */
export type AuthProviderKind = "email" | "google" | "oidc";

/**
 * Narrows the text column to the union (the `asApprovalState` precedent).
 * The "oidc" fallback is INERT in practice — rows are only ever written
 * through the route's validated kinds — and exists so a hand edit of the
 * column cannot break a read, which is why the column is text at all.
 */
export function asProviderKind(value: string | null | undefined): AuthProviderKind {
  return value === "email" || value === "google" || value === "oidc" ? value : "oidc";
}

/**
 * One admin-managed sign-in door. Booleans are 0/1 integers (SQLite);
 * `registrationEnabled` NULL means the legacy dynamic gate (§2) and is only
 * legal on the `email` row — OIDC rows always carry an explicit 0/1.
 */
export interface AuthProviderTable {
  id: string;
  kind: string; // narrow with asProviderKind; text so a hand edit cannot break reads
  name: string;
  issuer: Generated<string | null>;
  clientId: Generated<string | null>;
  clientSecret: Generated<string | null>;
  /** JSON {authorizationUrl, tokenUrl, userInfoUrl}, resolved at save (§3). */
  endpointsJson: Generated<string | null>;
  /** JSON array of origin strings, position 0 canonical (§5a). */
  entryOrigins: Generated<string | null>;
  /** Comma-separated bare domains, or null = any (§5). */
  allowedDomains: Generated<string | null>;
  enabled: Generated<number>;
  signInEnabled: Generated<number>;
  registrationEnabled: Generated<number | null>;
  requireApproval: Generated<number>;
  position: Generated<number>;
  createdAt: Generated<string>;
  updatedAt: Generated<string>;
}

/**
 * The plain-value row a SELECT returns. `Generated` is insert-time optionality
 * and lives on the table interface only — readers and callers deal in this.
 */
export type AuthProviderRow = Selectable<AuthProviderTable>;

/**
 * Insert shape (the `NewUserMeta` precedent): `id`/`kind`/`name` required,
 * every DB-defaulted column an optional PLAIN value — an insert caller must
 * not have to name the `Generated` wrapper.
 */
export type NewAuthProvider = Pick<AuthProviderTable, "id" | "kind" | "name"> &
  Partial<Omit<AuthProviderRow, "id" | "kind" | "name">>;
