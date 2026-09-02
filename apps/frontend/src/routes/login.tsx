import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCurrentUser } from "@/lib/auth";
import { authClient } from "@/lib/auth-client";
import { safeRedirect } from "@/lib/redirect";

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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (isLoading) return null;
  if (user) return <Navigate to={redirect ?? "/"} />;

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
      window.location.href = redirect ?? "/";
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
      window.location.href = redirect ?? "/";
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to Subshell</CardTitle>
          <CardDescription>Manage your agent harness sessions.</CardDescription>
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
            <p className="mt-2 text-muted-foreground text-xs">
              Passkeys are tied to this device and to the address this instance serves from. If you reached this page
              from a different address, passkey sign-in won&apos;t find them — use your password.
            </p>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
