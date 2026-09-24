import { Badge, cn } from "@internal/node-admin";
import { UserRowActions } from "@/components/users/user-row-actions";
import { useCurrentUser } from "@/lib/auth";
import { asUserRole, USER_ROLE_LABELS } from "@/types/user-role";

/**
 * The Provider column's word for one better-auth `providerId`. `credential`
 * is spelled like the Auth table's email kind (`KIND_LABELS.email`) so the
 * two pages cannot name the same door differently; `google` is the preset's
 * id and gets the same word. Anything else renders the id itself — a custom
 * OIDC door's row cannot be resolved to its admin-chosen name from this
 * payload alone, and guessing a name would be worse than printing the id.
 */
export function providerBadgeLabel(providerId: string): string {
  if (providerId === "credential") return "Email";
  if (providerId === "google") return "Google";
  return providerId;
}

/** One account on the instance, as `GET /api/users` returns it. */
export interface UserRow {
  /** better-auth user id */
  id: string;
  /** Display name, asked for at creation (spec 2026-09-14 §1) */
  name: string;
  /** Sign-in identity */
  email: string;
  /** Null for a user with no `user_meta` row, which renders as "user" */
  role: string | null;
  /** ISO 8601, or null for a row written before the column existed */
  createdAt: string | null;
  /**
   * False for the `system` service account. Server-derived: the rule lives
   * with the endpoint that enforces it, so the UI cannot offer a control that
   * is guaranteed to be refused, and never hardcodes the service address.
   * Optional for a payload cached before the field existed.
   */
  manageable?: boolean;
  /**
   * The account is locked out: it cannot sign in and holds no sessions.
   * Optional for a payload cached before the field existed, which reads as
   * enabled — the state every account was in before this could be set.
   */
  disabled?: boolean;
  /**
   * Auth provider ids this account has sign-in rows for — `credential`,
   * `google`, or a custom door's id. Absent = older payload: the Provider
   * column renders nothing and the menu keeps Reset password (the server's
   * 409 stays the truth) rather than guessing from a field that never
   * arrived.
   */
  providers?: string[];
}

/** One badge per sign-in row, the credential door spelled like the Auth page. */
function ProviderBadges({ providers }: { providers: readonly string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {providers.map((id) => (
        <Badge key={id} variant={id === "credential" ? "secondary" : "default"}>
          {providerBadgeLabel(id)}
        </Badge>
      ))}
    </div>
  );
}

/**
 * The roster table on `/settings/users`: one row per account, with the
 * per-user controls on every row the server says is manageable.
 *
 * The page renders this only inside its admin branch, so there is no
 * viewer-gating here — every row carries its controls, and the one exception
 * is the server's own `manageable` flag rather than a client-side match on
 * the service account's address.
 */
export function UsersTable({
  users,
  onChanged,
}: {
  /** Every account, in the order the server listed them */
  users: readonly UserRow[];
  /** A role, password or disabled flag changed — refetch the roster */
  onChanged: () => void;
}) {
  // Own id, so the row for yourself offers a label instead of controls: every
  // one of them is a way to remove your own administration, and an instance
  // need not have a second admin to put it back.
  const { data: currentUser } = useCurrentUser();

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="pr-4 pb-2 font-strong">Name</th>
            <th className="pr-4 pb-2 font-strong">Email</th>
            <th className="pr-4 pb-2 font-strong">Provider</th>
            <th className="pr-4 pb-2 font-strong">Role</th>
            <th className="pr-4 pb-2 font-strong">Created</th>
            {/* No visible title above a column of kebab buttons: a header
                over rows whose only content is "Your account" or "Service
                account" reads as a control that failed to render, not as the
                statement that the row is not manageable. The name is
                `aria-label`, deliberately NOT the Nodes table's `<span
                className="sr-only">`: sr-only is `position:absolute`, and
                with no positioned ancestor the span's containing block is the
                viewport, so it escapes this table's own `overflow-x-auto`
                clip and extends the DOCUMENT's scroll width at phone width —
                the e2e "Add user dialog fits" spec caught exactly that. */}
            <th className="pb-2 text-right font-strong" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b align-middle last:border-0">
              {/* A disabled account is dimmed as well as badged: the badge is
                  what states it, the dimming is what makes a locked-out row
                  legible while scanning the column of names. */}
              <td className={cn("py-2 pr-4", u.disabled && "text-muted-foreground")}>{u.name}</td>
              <td className={cn("py-2 pr-4", u.disabled && "text-muted-foreground")}>{u.email}</td>
              {/* Absent = an older payload: render nothing rather than guess a
                  set of doors. An empty list IS the payload's answer — the
                  `system` account has no sign-in row — and it renders as the
                  same nothing, which keeps that row exactly as it read
                  before this column existed. */}
              <td className="py-2 pr-4">{u.providers && <ProviderBadges providers={u.providers} />}</td>
              <td className="py-2 pr-4">
                {/* `Badge` renders a div, so the wrapper is one too. */}
                <div className="flex flex-wrap items-center gap-1">
                  {/* The role badge keeps saying the role even when the
                      account is disabled — a disabled admin IS an admin, and
                      one badge cannot answer both questions. */}
                  <Badge variant={asUserRole(u.role) === "admin" ? "success" : "secondary"}>
                    {USER_ROLE_LABELS[asUserRole(u.role)]}
                  </Badge>
                  {u.disabled && <Badge variant="warning">Disabled</Badge>}
                </div>
              </td>
              <td className="py-2 pr-4 text-muted-foreground">
                {u.createdAt ? new Date(u.createdAt).toLocaleString() : "—"}
              </td>
              <td className="py-2 text-right">
                {u.manageable === false ? (
                  <span className="text-detail text-muted-foreground">Service account</span>
                ) : (
                  <UserRowActions user={u} viewerId={currentUser?.id ?? null} onChanged={onChanged} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
