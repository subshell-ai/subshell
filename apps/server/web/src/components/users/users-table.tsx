import { Badge, cn } from "@internal/node-admin";
import { UserRowActions } from "@/components/users/user-row-actions";
import { useCurrentUser } from "@/lib/auth";
import { asUserRole, USER_ROLE_LABELS } from "@/types/user-role";

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
            <th className="pr-4 pb-2 font-strong">Role</th>
            <th className="pr-4 pb-2 font-strong">Created</th>
            {/* The Nodes table's idiom: no visible title above a column of
                kebab buttons, because a "Manage" header over rows that say
                "Your account" or "Service account" reads as controls that
                failed to render. Screen readers still get the column name. */}
            <th className="pb-2 text-right font-strong">
              <span className="sr-only">Actions</span>
            </th>
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
