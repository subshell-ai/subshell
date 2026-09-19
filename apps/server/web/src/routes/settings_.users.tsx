import { apiFetch, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@internal/node-admin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { AddUserDialog } from "@/components/users/add-user-dialog";
import { type UserRow, UsersTable } from "@/components/users/users-table";
import { usePublicSettings } from "@/hooks/use-public-settings";

export const Route = createFileRoute("/settings_/users")({ component: UsersPage });

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
 */
function UsersPage() {
  const queryClient = useQueryClient();
  const { data: publicSettings } = usePublicSettings();
  const viewerIsAdmin = publicSettings?.viewerIsAdmin;
  const [addOpen, setAddOpen] = useState(false);

  const {
    data: envelope,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["users"],
    queryFn: () => apiFetch<UsersEnvelope>("/api/users"),
    enabled: viewerIsAdmin === true,
    retry: false,
  });

  const invalidateRoster = () => void queryClient.invalidateQueries({ queryKey: ["users"] });

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Users"
        subtitle="Who can sign in to this instance (admins)"
        action={viewerIsAdmin === true ? <Button onClick={() => setAddOpen(true)}>Add user</Button> : undefined}
      />
      {viewerIsAdmin === undefined ? null : viewerIsAdmin ? (
        <>
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
