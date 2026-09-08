import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserRowActions } from "@/components/users/user-row-actions";
import { apiFetch, errMessage } from "@/lib/api";
import { useCurrentUser } from "@/lib/auth";

export const Route = createFileRoute("/users")({
  component: UsersPage,
});

interface UserRow {
  id: string;
  email: string;
  role: string | null;
  createdAt: string | null;
  /**
   * False for the `system` service account. Server-derived: the rule lives
   * with the endpoint that enforces it, so the UI cannot offer a control that
   * is guaranteed to be refused, and never hardcodes the service address.
   * Optional for a payload cached before the field existed.
   */
  manageable?: boolean;
}

interface AuditEvent {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
  createdAt: string;
}

interface UsersEnvelope {
  viewerIsAdmin: boolean;
  users: UserRow[];
}

function UsersPage() {
  const queryClient = useQueryClient();
  const {
    data: envelope,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["users"],
    queryFn: () => apiFetch<UsersEnvelope>("/api/users"),
    retry: false,
  });

  // Strict: while the envelope is loading (undefined) or for members (false),
  // the audit query stays disabled so it can never fire a doomed 403 request.
  const viewerIsAdmin = envelope?.viewerIsAdmin === true;
  // Own id, so the row for yourself offers a role control but no password
  // reset — that path lives under Account, where the current password is
  // required.
  const { data: currentUser } = useCurrentUser();

  const {
    data: auditEvents,
    isError: auditIsError,
    isLoading: auditIsLoading,
  } = useQuery({
    queryKey: ["audit"],
    queryFn: () => apiFetch<AuditEvent[]>("/api/audit?limit=50"),
    enabled: viewerIsAdmin,
    retry: false,
  });

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    try {
      await apiFetch("/api/users", {
        method: "POST",
        body: JSON.stringify({ email, password, role }),
      });
      setEmail("");
      setPassword("");
      setRole("user");
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      await queryClient.invalidateQueries({ queryKey: ["audit"] });
    } catch (err) {
      setErrorMsg(errMessage(err, "Failed to create user"));
    } finally {
      setBusy(false);
    }
  }

  // Cold-load gate: without it an admin first paints the member view (header
  // copy flip + card layout shift) until the envelope lands — adjudicated in
  // Task 4 review. In-app navigations keep painting from the query cache.
  if (isLoading && !envelope) {
    return (
      <main className="mx-auto w-full max-w-3xl p-6">
        <Card>
          <CardHeader>
            <CardTitle>Users</CardTitle>
            <CardDescription>Loading the roster…</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  // GET /api/users no longer 403s for members, so any error here is a genuine
  // load failure (network, session expiry, server error) rather than a permissions one.
  if (error) {
    return (
      <main className="mx-auto w-full max-w-3xl p-6">
        <Card>
          <CardHeader>
            <CardTitle>Users</CardTitle>
            <CardDescription>Couldn&apos;t load the roster — check your connection or sign in again.</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Users"
        subtitle={viewerIsAdmin ? "Admin user management and audit trail" : "The people on this instance"}
      />

      {viewerIsAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>Add user</CardTitle>
            <CardDescription>Creates a credential account that can sign in immediately.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={createUser} className="grid grid-cols-1 items-start gap-3 sm:grid-cols-12">
              <div className="space-y-2 sm:col-span-4">
                <Label htmlFor="user-email">Email</Label>
                <Input
                  id="user-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="person@example.com"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2 sm:col-span-4">
                <Label htmlFor="user-password">Password</Label>
                <Input
                  id="user-password"
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="min 8 characters"
                  autoComplete="new-password"
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="user-role">Role</Label>
                <Select value={role} onValueChange={(v) => v !== null && setRole(v as "admin" | "user")}>
                  <SelectTrigger id="user-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">user</SelectItem>
                    <SelectItem value="admin">admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 sm:col-span-2">
                {/* Invisible label so the button aligns with the other fields' bottoms. */}
                <Label aria-hidden="true" className="invisible">
                  Role
                </Label>
                <Button type="submit" disabled={busy} className="w-full">
                  {busy ? "Creating…" : "Add user"}
                </Button>
              </div>
            </form>
            {errorMsg && <p className="mt-2 text-destructive text-sm">{errorMsg}</p>}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>{envelope?.users.length ?? 0} accounts on this instance</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pr-4 pb-2 font-medium">Email</th>
                    <th className="pr-4 pb-2 font-medium">Role</th>
                    <th className="pr-4 pb-2 font-medium">Created</th>
                    {viewerIsAdmin && <th className="pb-2 font-medium">Manage</th>}
                  </tr>
                </thead>
                <tbody>
                  {envelope?.users.map((u) => (
                    <tr key={u.id} className="border-b align-middle last:border-0">
                      <td className="py-2 pr-4">{u.email}</td>
                      <td className="py-2 pr-4">
                        <Badge
                          variant={u.role === "admin" ? "success" : "secondary"}
                          className="inline-flex items-center"
                        >
                          {u.role ?? "user"}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {u.createdAt ? new Date(u.createdAt).toLocaleString() : "—"}
                      </td>
                      {viewerIsAdmin && (
                        <td className="py-2">
                          {u.manageable === false ? (
                            <span className="text-muted-foreground text-xs">Service account</span>
                          ) : (
                            <UserRowActions
                              user={u}
                              viewerId={currentUser?.id ?? null}
                              onChanged={() => {
                                void queryClient.invalidateQueries({ queryKey: ["users"] });
                                // The audit table sits on this same page — a
                                // role change or reset that did not refresh it
                                // would look unrecorded.
                                void queryClient.invalidateQueries({ queryKey: ["audit"] });
                              }}
                            />
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {viewerIsAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>Audit trail</CardTitle>
            <CardDescription>Latest subshell lifecycle and admin events.</CardDescription>
          </CardHeader>
          <CardContent>
            {/* Error ≠ empty ≠ loading — the roster above got this treatment
                first; the trail follows its vocabulary. */}
            {auditIsError ? (
              <p className="text-muted-foreground text-sm">
                Couldn&apos;t load the audit trail — check your connection or sign in again.
              </p>
            ) : auditIsLoading ? (
              <p className="text-muted-foreground text-sm">Loading…</p>
            ) : !auditEvents?.length ? (
              <p className="text-muted-foreground text-sm">No events recorded yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pr-4 pb-2 font-medium">When</th>
                      <th className="pr-4 pb-2 font-medium">Action</th>
                      <th className="pr-4 pb-2 font-medium">Target</th>
                      <th className="pb-2 font-medium">Context</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditEvents.map((e) => (
                      <tr key={e.id} className="border-b last:border-0">
                        <td className="py-2 pr-4 text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</td>
                        <td className="py-2 pr-4 font-mono text-xs">{e.action}</td>
                        <td className="py-2 pr-4 text-muted-foreground">
                          {e.targetType ? `${e.targetType}:${e.targetId?.slice(0, 8)}` : "—"}
                        </td>
                        <td className="py-2 text-muted-foreground">{JSON.stringify(e.metadata ?? {})}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </main>
  );
}
