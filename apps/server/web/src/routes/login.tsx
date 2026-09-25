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
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { INSTANCE_NAME_QUERY_KEY } from "@/hooks/use-auth-providers";
import { getSessionUser, useCurrentUser } from "@/lib/auth";
import { authClient } from "@/lib/auth-client";
import { isServerDesktop } from "@/lib/desktop";
import { safeRedirect } from "@/lib/redirect";
import { mapAuthError, SESSION_CHECK_FAILED, signInButtonLabel, signInDiagnosis } from "@/lib/sign-in-diagnosis";
import { passkeysSupported } from "@/lib/webauthn";
import type { InstanceSignInRead } from "@/types/auth-provider";

export const Route = createFileRoute("/login")({
  // The signed-out guard (__root) sends visitors here with the path they
  // wanted; safeRedirect has already vetoed anything non-same-site.
  // (search.redirect is `unknown` until narrowed — apiFetch-style care.)
  //
  // `error`/`error_description` are the failed OAuth round trip better-auth
  // appends to the errorCallbackURL (spec 2026-09-24 §4). Raw strings, only
  // passed through: `mapAuthError` decides what they MEAN — pending leaves
  // for /pending, the sessionless shape gets the honest generic line, and
  // any other code RENDERS its sanitized sentence (final review, Important
  // 2: unrecognized refusals used to paint nothing). Only the form's own
  // errors (wrong password, dropped request) arrive through `error` state.
  validateSearch: (
    search: Record<string, unknown>,
  ): { redirect?: string; error?: string; error_description?: string } => {
    const r = typeof search.redirect === "string" ? safeRedirect(search.redirect) : null;
    const error = typeof search.error === "string" ? search.error : undefined;
    const errorDescription = typeof search.error_description === "string" ? search.error_description : undefined;
    return {
      ...(r ? { redirect: r } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(errorDescription !== undefined ? { error_description: errorDescription } : {}),
    };
  },
  component: LoginPage,
});

function LoginPage() {
  const { redirect, error: searchError, error_description: searchErrorDescription } = Route.useSearch();
  const { data: user, isLoading } = useCurrentUser();
  // Its OWN query rather than a slice of ["setup-status"]: that one is cached
  // with an infinite stale time because `needsSetup` is true exactly once in
  // an instance's life, and a renameable value must not inherit that.
  // Since the OIDC work (spec 2026-09-24 §7) the same anonymous read answers
  // WHICH DOORS exist — the login page cannot ask that AFTER it asked for a
  // password. Both newer fields are optional: an older server omits them and
  // the page behaves exactly as it always did (form shown, no buttons).
  const { data: instance } = useQuery({
    queryKey: INSTANCE_NAME_QUERY_KEY,
    queryFn: () => apiFetch<InstanceSignInRead>("/api/settings/instance"),
    staleTime: 30_000,
  });
  const instanceName = instance?.instanceName;
  const providers = instance?.providers ?? [];
  // Absent (an older server) reads OPEN, like every other optional field
  // here: a door this read cannot see is a door this page must not hide.
  const emailSignIn = instance?.emailSignIn !== false;
  const noDoors = !emailSignIn && providers.length === 0;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The failed round trip better-auth returned us to (`?error=…`, spec §4).
  // A pending identity is not an error to print, it is a screen to move to;
  // the sessionless refusal and every other code the trip can carry get
  // their own line above the door block — the generic sentence, or the
  // sanitized description. A fresh attempt retires the captured decision.
  //
  // DECIDED ONCE, from the params as this component MOUNTED with them: the
  // effect below clears the consumed params out of the URL (Task 14 review,
  // minor 1: a consumed `unable_to_create_session` was sticky, so a later
  // mistyped password showed the old refusal beside the new one), and a
  // decision still riding the live params would blink out together with them.
  const [authError, setAuthError] = useState(() =>
    mapAuthError({ error: searchError, error_description: searchErrorDescription }),
  );
  const navigate = useNavigate();
  useEffect(() => {
    // Pending is excluded because its <Navigate to="/pending"> already leaves
    // this URL (replace, carrying the email) — a second replace racing it from
    // the effect could land the visitor back on a cleaned /login instead of
    // the waiting room.
    if (authError.kind === "pending") return;
    if (searchError === undefined && searchErrorDescription === undefined) return;
    void navigate({ to: "/login", search: redirect ? { redirect } : {}, replace: true });
  }, [authError, navigate, redirect, searchError, searchErrorDescription]);

  if (isLoading) return null;
  if (user) return <Navigate to={redirect ?? "/"} />;
  // A session beats a stale query: someone who signed in between the refusal
  // and this render is going in, not to the waiting room.
  if (authError.kind === "pending") {
    // The brief's string-concatenation form (`to={"/pending?email=…"}`) does
    // not typecheck: the router's `to` is the literal path union, and search
    // is the typed half. The router URL-encodes the value itself, so the
    // waiting room is addressed by exactly the URL the brief describes.
    return <Navigate to="/pending" search={authError.email ? { email: authError.email } : {}} replace />;
  }

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
    // A fresh attempt retires the earlier round-trip refusal: within the SAME
    // page-view the captured decision used to outlive its moment, painting the
    // stale OAuth line beside the new password error (Task 14 re-review nit).
    setAuthError({ kind: "none" });
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
    setAuthError({ kind: "none" });
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
          {/* The generic round-trip refusal lives ABOVE the door block, not in
              the form: it names what the OAuth trip did, and with the E-mail
              door closed the form is not on this page to carry the line. The
              form's own errors (a wrong password, a dropped request) stay
              where they always were. */}
          {(authError.kind === "generic" || authError.kind === "refused") && (
            <p className="mb-4 text-destructive text-detail">{authError.message}</p>
          )}
          {/* No door open at all (spec §7): say so rather than paint an empty
              card. The email flag's ABSENCE is not "no doors" — an older
              server answers neither field, and the form stays. */}
          {noDoors ? (
            <p className="text-detail text-muted-foreground">No sign-in methods are configured on this instance.</p>
          ) : (
            <>
              {emailSignIn && (
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
                  {error && <p className="text-destructive text-detail">{error}</p>}
                  <Button type="submit" className="w-full" disabled={busy}>
                    {busy ? "Signing in…" : "Sign in"}
                  </Button>
                </form>
              )}
              {/* The OAuth doors, above the passkey block (spec §7): each one
                  is a full-page redirect, not the fetch-style call the form
                  makes — the IdP round trip leaves this document and better-
                  auth returns to errorCallbackURL with the outcome appended
                  as `?error=…`, which the mapper above reads. The label is
                  the provider's NAME for every kind (operator contract,
                  2026-09-24): same-kind doors are legal, and a kind-first
                  label would render two Google rows indistinguishable — a
                  mis-click lands on the wrong IdP's consent screen.
                  `signInButtonLabel` owns that copy, tested. */}
              {providers.length > 0 && (
                <div className={emailSignIn ? "mt-4 space-y-2" : "space-y-2"}>
                  {providers.map((p) => (
                    <Button
                      key={p.id}
                      type="button"
                      variant="outline"
                      className="w-full"
                      disabled={busy}
                      onClick={() =>
                        void authClient.signIn.social({
                          provider: p.id,
                          callbackURL: redirect ?? "/",
                          errorCallbackURL: `${window.location.origin}/login`,
                        })
                      }
                    >
                      {signInButtonLabel(p)}
                    </Button>
                  ))}
                </div>
              )}
            </>
          )}
          {/* Hidden where WebAuthn does not exist — an embedded webview has no
            platform authenticator, so the button could only ever fail. The
            note goes with it: it explains a control that is not there.
            Hidden with the closed E-mail door too (spec §7): a passkey is a
            credential account, so it rides the credential door. */}
          {emailSignIn && passkeysSupported() && (
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
