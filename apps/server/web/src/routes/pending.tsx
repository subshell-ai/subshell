import { apiFetch, Button, Card, CardContent, CardHeader, CardTitle } from "@internal/node-admin";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { INSTANCE_NAME_QUERY_KEY } from "@/hooks/use-auth-providers";
import { useCurrentUser } from "@/lib/auth";
import type { InstanceSignInRead } from "@/types/auth-provider";

export const Route = createFileRoute("/pending")({
  // `email` arrives from the login page, which decoded it from the round
  // trip's `error_description` (spec 2026-09-24 §4). Raw pass-through: it is
  // rendered as text only, and its absence (a refusal that named no address)
  // is a shape the page renders, not an error.
  validateSearch: (search: Record<string, unknown>): { email?: string } =>
    typeof search.email === "string" ? { email: search.email } : {},
  component: PendingPage,
});

/**
 * The waiting room (spec 2026-09-24 §7): a sign-in whose identity exists but
 * no admin has approved yet. Bare frame, like `/login` and `/setup`.
 *
 * There is deliberately NO copy distinguishing pending from rejected: the
 * provider policy answers both with the same refusal, and telling a stranger
 * "an admin decided no" versus "an admin has not looked yet" is information
 * this surface does not have and must not invent.
 *
 * "Sign in again" walks back through `/login`, which is the design: the round
 * trip re-lands HERE while the row is still pending, so the wait re-checks
 * the provider for free rather than holding a stale screen.
 *
 * A signed-in visitor is NOT waiting: the screen asks the session the same
 * question login does, and one that exists goes to `/` instead (Task 14
 * review, minor 2: the bookmarked waiting room, and the approval that lands
 * while the person is still sitting here).
 */
function PendingPage() {
  const { email } = Route.useSearch();
  const navigate = useNavigate();
  const { data: user, isLoading } = useCurrentUser();
  const { data: instance } = useQuery({
    queryKey: INSTANCE_NAME_QUERY_KEY,
    queryFn: () => apiFetch<InstanceSignInRead>("/api/settings/instance"),
    staleTime: 30_000,
  });
  const instanceName = instance?.instanceName;

  // Hold first paint for the session answer, like login does: painting the
  // waiting card to a signed-in visitor for a frame would BE the stale screen
  // this guard exists to close.
  if (isLoading) return null;
  if (user) return <Navigate to="/" />;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 p-6">
      <img src="/icons/wordmark-96.png" srcSet="/icons/wordmark-192.png 2x" alt="Subshell" className="h-14 w-auto" />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to {instanceName ?? "Subshell"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-detail text-muted-foreground">
            Your sign-in is awaiting approval by an administrator. Nothing to do but wait.
          </p>
          {email && <p className="font-strong text-label">{email}</p>}
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => void navigate({ to: "/login", search: { redirect: "/" } })}
          >
            Sign in again
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
