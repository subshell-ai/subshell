import { Badge } from "@/components/ui/badge";
import { UserRowActions } from "@/components/users/user-row-actions";
import { useCurrentUser } from "@/lib/auth";

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
  /** A role or password changed — refetch the roster */
  onChanged: () => void;
}) {
  // Own id, so the row for yourself offers a role control but no password
  // reset — that path lives under Account, where the current password is
  // required.
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
            <th className="pb-2 font-strong">Manage</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b align-middle last:border-0">
              <td className="py-2 pr-4">{u.name}</td>
              <td className="py-2 pr-4">{u.email}</td>
              <td className="py-2 pr-4">
                <Badge variant={u.role === "admin" ? "success" : "secondary"} className="inline-flex items-center">
                  {u.role ?? "user"}
                </Badge>
              </td>
              <td className="py-2 pr-4 text-muted-foreground">
                {u.createdAt ? new Date(u.createdAt).toLocaleString() : "—"}
              </td>
              <td className="py-2">
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
