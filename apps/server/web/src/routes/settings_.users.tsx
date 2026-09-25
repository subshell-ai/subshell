import {
  apiFetch,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@internal/node-admin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Segmented } from "@/components/ui/segmented";
import { AddUserDialog } from "@/components/users/add-user-dialog";
import { PendingUsersTable } from "@/components/users/pending-users-table";
import { type UserRow, UsersTable } from "@/components/users/users-table";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { USERS_QUERY_KEY, useUsersPending } from "@/hooks/use-users-pending";

/** The page's two halves, keyed in the URL. Order is the tabs' order. */
const USERS_TABS = [
  { value: "members", label: "Members" },
  { value: "pending", label: "Pending approval" },
] as const;

type UsersTab = (typeof USERS_TABS)[number]["value"];

export const Route = createFileRoute("/settings_/users")({
  component: UsersPage,
  // ABSENCE is the default, the Logs page's rule: only `?tab=pending` rides
  // the URL, so the plain path is the Members tab's address. Any other value
  // reads as the default, never as an error.
  validateSearch: (search: Record<string, unknown>): { tab?: "pending" } =>
    search.tab === "pending" ? { tab: "pending" } : {},
});

/** Shape of `GET /api/users` — instance-wide read, admin-gated writes. */
interface UsersEnvelope {
  /** True for an admin COOKIE session; the page's own gate reads public settings instead */
  viewerIsAdmin: boolean;
  /** Every account on the instance, the `system` service user included */
  users: UserRow[];
}

/**
 * The user roster — an admin page under Server Settings (spec 2026-09-14).
 *
 * It used to live at `/users`, outside the `/settings/*` namespace and
 * reachable by URL for members, who saw a read-only table. That table answered
 * a question nobody asked: the roster exists so the sharing picker can name
 * people, and that reads the API, not this page. So the page is admin-only
 * now, and the gate is the one Status and Audit use — server-derived
 * `viewerIsAdmin`, `undefined` counting as NOT admin — with the roster query
 * `enabled` on it, so a member's mount fires no request at all.
 *
 * The gate reads public settings rather than the roster envelope's own
 * `viewerIsAdmin`, which would be circular: the envelope arrives only from
 * the request the gate is deciding whether to make.
 *
 * Since OIDC (spec 2026-09-24 §6) the page has two halves as tabs, the Logs
 * page's URL-state pattern: the approved Members roster, and the approval
 * queue behind `?tab=pending`. The queue is fetched whenever an admin has the
 * page open, not only while its tab is active, because its COUNT rides on the
 * tab label: an admin reading Members still sees who is waiting. A member's
 * mount fires neither request.
 */
function UsersPage() {
  const queryClient = useQueryClient();
  const { data: publicSettings } = usePublicSettings();
  const viewerIsAdmin = publicSettings?.viewerIsAdmin;
  const isAdmin = viewerIsAdmin === true;
  const [addOpen, setAddOpen] = useState(false);
  const { tab } = Route.useSearch();
  const active: UsersTab = tab ?? "members";
  const navigate = Route.useNavigate();

  const {
    data: envelope,
    isLoading,
    error,
  } = useQuery({
    queryKey: USERS_QUERY_KEY,
    queryFn: () => apiFetch<UsersEnvelope>("/api/users"),
    enabled: isAdmin,
    retry: false,
  });

  const { data: pendingRows, isLoading: pendingIsLoading, error: pendingError } = useUsersPending(isAdmin);

  const invalidateRoster = () => void queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });

  // The tab label's count: every queue row, pending and rejected alike — a
  // rejected arrival is still an unanswered knock. Until the read lands there
  // is no number to show, so the label stays just its words, spelled once in
  // USERS_TABS rather than repeated at the badge.
  const pendingCount = pendingRows?.length ?? 0;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Users"
        subtitle="Who can sign in to this instance"
        action={
          isAdmin ? (
            <Button onClick={() => setAddOpen(true)}>
              <Plus /> Add user
            </Button>
          ) : undefined
        }
      />
      {viewerIsAdmin === undefined ? null : isAdmin ? (
        <>
          <Segmented
            ariaLabel="Which list"
            // A page's tab strip is content-sized, never a half-page-each
            // stretch (design-system.md rule, 2026-09-25).
            fill={false}
            // The tab words live in USERS_TABS; only the Pending one ever
            // wears a count, and it wears its own word plus the number.
            options={USERS_TABS.map((t) =>
              t.value === "pending" && pendingCount > 0
                ? {
                    ...t,
                    label: (
                      <span className="flex items-center gap-1.5">
                        {t.label}
                        <Badge variant="secondary">{pendingCount}</Badge>
                      </span>
                    ),
                  }
                : t,
            )}
            value={active}
            onChange={(next) => void navigate({ search: next === "pending" ? { tab: "pending" } : {} })}
          />
          {active === "members" ? (
            <Card>
              <CardHeader>
                <CardTitle>Users</CardTitle>
                <CardDescription>
                  {error
                    ? "Couldn't load the roster. Check your connection or sign in again."
                    : isLoading
                      ? "Loading the roster…"
                      : `${envelope?.users.length ?? 0} accounts on this instance`}
                </CardDescription>
              </CardHeader>
              {!error && !isLoading && (
                <CardContent>
                  <UsersTable users={envelope?.users ?? []} onChanged={invalidateRoster} />
                </CardContent>
              )}
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Pending approval</CardTitle>
                <CardDescription>
                  {pendingError
                    ? "Couldn't load the approval queue. Check your connection or sign in again."
                    : pendingIsLoading
                      ? "Loading the queue…"
                      : "Approving makes them a member. Rejecting keeps the row here as the record; nothing in this queue deletes one"}
                </CardDescription>
              </CardHeader>
              {!pendingError && !pendingIsLoading && (
                <CardContent>
                  <PendingUsersTable rows={pendingRows ?? []} />
                </CardContent>
              )}
            </Card>
          )}
          <AddUserDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            onCreated={() => {
              invalidateRoster();
              // The sharing picker reads the same roster under its own key, so
              // a dialog left open beside this one learns about the new person
              // instead of offering a list that is already wrong.
              void queryClient.invalidateQueries({ queryKey: ["sharable-users"] });
            }}
          />
        </>
      ) : (
        <p className="text-muted-foreground text-sm">
          The user list is for instance admins; your settings live under{" "}
          <Link to="/preferences" className="underline">
            Preferences
          </Link>{" "}
          and{" "}
          <Link to="/account" className="underline">
            Account settings
          </Link>
          .
        </p>
      )}
    </main>
  );
}
