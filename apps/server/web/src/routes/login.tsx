import {
  apiFetch,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@internal/node-admin";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { getSessionUser, useCurrentUser } from "@/lib/auth";
import { authClient } from "@/lib/auth-client";
import { isServerDesktop } from "@/lib/desktop";
import { safeRedirect } from "@/lib/redirect";
import { SESSION_CHECK_FAILED, signInDiagnosis } from "@/lib/sign-in-diagnosis";
import { passkeysSupported } from "@/lib/webauthn";

export const Route = createFileRoute("/login")({
  // The signed-out guard (__root) sends visitors here with the path they
  // wanted; safeRedirect has already vetoed anything non-same-site.
  // (search.redirect is `unknown` until narrowed — apiFetch-style care.)
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const r = typeof search.redirect === "string" ? safeRedirect(search.redirect) : null;
    return r ? { redirect: r } : {};
  },
  component: LoginPage,
});

function LoginPage() {
  const { redirect } = Route.useSearch();
  const { data: user, isLoading } = useCurrentUser();
  // Its OWN query rather than a slice of ["setup-status"]: that one is cached
  // with an infinite stale time because `needsSetup` is true exactly once in
  // an instance's life, and a renameable value must not inherit that.
  const { data: instance } = useQuery({
    queryKey: ["instance-name"],
    queryFn: () => apiFetch<{ instanceName: string }>("/api/settings/instance"),
    staleTime: 30_000,
  });
  const instanceName = instance?.instanceName;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (isLoading) return null;
  if (user) return <Navigate to={redirect ?? "/"} />;

  /**
   * Leave for the app, unless the session did not actually take.
   *
   * **A 200 is not a session** (operator's report, 2026-09-18). better-auth
   * derives cookie security from `APP_BASE_URL` rather than from the request,
   * so an instance whose base URL is an https address marks its session cookie
   * `Secure` and prefixes it `__Secure-` — and a browser on an http page
   * discards it on receipt. The sign-in then succeeds, this line navigates to
   * `/`, `/` finds no session and bounces back here: the "brief transition"
   * that looks like the form rejecting a correct password.
   *
   * So the redirect is gated on the session EXISTING. One extra round trip on
   * the one press where being wrong costs a person their way in.
   *
   * **A check that could not run is its own answer** (review, 2026-09-18).
   * `getSessionUser` returns null only for a 401/403 and THROWS on anything
   * else, precisely so a failed read is never read as signed-out — so
   * swallowing that into null here would put the cookie diagnosis on screen
   * for a dropped request, which has nothing to do with cookies and whose
   * remedy would send someone to change a working address.
   */
  async function leaveIfSignedIn() {
    let user: Awaited<ReturnType<typeof getSessionUser>>;
    try {
      user = await getSessionUser();
    } catch {
      setError(SESSION_CHECK_FAILED);
      return;
    }
    if (user !== null) {
      window.location.href = redirect ?? "/";
      return;
    }
    const { message, remedy } = signInDiagnosis({
      inServerApp: isServerDesktop(),
      protocol: window.location.protocol,
    });
    setError(remedy === "" ? message : `${message} ${remedy}`);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { error: signInError } = await authClient.signIn.email({ email, password });
      if (signInError) {
        setError(signInError.message ?? "Sign-in failed");
        return;
      }
      await leaveIfSignedIn();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithPasskey() {
    setBusy(true);
    setError(null);
    try {
      const { error: pkError } = await authClient.signIn.passkey({});
      if (pkError) {
        const code = (pkError as unknown as { code?: string }).code;
        // Dismissing the platform chooser is a cancel, not an app failure.
        if (code !== "AUTH_CANCELLED") setError(pkError.message ?? "Passkey sign-in failed");
        return;
      }
      await leaveIfSignedIn();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 p-6">
      <img src="/icons/wordmark-96.png" srcSet="/icons/wordmark-192.png 2x" alt="Subshell" className="h-14 w-auto" />
      <Card className="w-full max-w-sm">
        <CardHeader>
          {/* Name the plane you are about to hand a password to. The read is
              anonymous by design (spec 2026-09-08) and deliberately not
              load-bearing: while it is pending or failed, the form is
              unchanged and fully usable. */}
          <CardTitle>Sign in to {instanceName ?? "Subshell"}</CardTitle>
          <CardDescription>Manage your agent harness subshells.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
          {/* Hidden where WebAuthn does not exist — an embedded webview has no
            platform authenticator, so the button could only ever fail. The
            note goes with it: it explains a control that is not there. */}
          {passkeysSupported() && (
            <div className="mt-4">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={busy}
                onClick={() => void signInWithPasskey()}
              >
                Sign in with a passkey
              </Button>
              <p className="mt-2 text-detail text-muted-foreground">
                Passkeys are tied to this device and to the address this instance serves from. If you reached this page
                from a different address, use your password.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
