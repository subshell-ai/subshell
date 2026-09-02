import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { HarnessRow } from "@/components/harness-row";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useHarnessToggles } from "@/hooks/use-harness-toggles";
import { useHarnesses, useRecheckHarnesses } from "@/hooks/use-harnesses";
import { apiFetch } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/setup")({
  component: SetupPage,
});

const STEPS = ["Account", "Harness"] as const;

function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => apiFetch<{ needsSetup: boolean }>("/api/setup/status"),
  });
  const [step, setStep] = useState(0);

  // Registration (better-auth sign-up)
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [confirmTouched, setConfirmTouched] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Harness management — install help and the Enable/switch live on each row
  // (the shared HarnessRow). No selection: every enabled harness
  // already has a blank Default profile (seeded at registration), so a user
  // who wants to launch straight away can finish here and never touch a
  // profile. Enabling a harness on this step also seeds its Default.
  const { data: harnesses, isLoading: harnessesLoading, isError: harnessesError } = useHarnesses();
  const recheck = useRecheckHarnesses();
  const { toggle: toggleHarness, errors: harnessErrors, pending: togglePending } = useHarnessToggles();

  useEffect(() => {
    if (status?.needsSetup === false) {
      navigate({ to: "/" });
    }
  }, [status, navigate]);

  if (!status) return null;

  async function register() {
    setBusy(true);
    setRegError(null);
    try {
      const { error: signUpError } = await authClient.signUp.email({ name, email, password });
      if (signUpError) {
        setRegError(signUpError.message ?? "Registration failed");
        return;
      }
      // Sign-up just created the session cookie, but the shell's guard still
      // holds the pre-registration `null` session (30 s staleTime) and would
      // bounce this SPA navigation to /login. Refresh it so the guard knows.
      queryClient.invalidateQueries({ queryKey: ["current-user"] });
      setStep(1);
    } catch {
      setRegError("Network error");
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    // The shared ["setup-status"] cache still says needsSetup:true for its
    // staleTime window (10 s). The Sessions page reads it on its first
    // render and bounces straight back to /setup — a wizard finished in
    // under 10 s would be trapped there — so retire it before navigating.
    queryClient.setQueryData(["setup-status"], { needsSetup: false });
    navigate({ to: "/" });
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Welcome to Subshell</CardTitle>
          <CardDescription>
            Step {step + 1} of {STEPS.length}: {STEPS[step]}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {step === 0 && (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void register();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password-confirm">Confirm password</Label>
                <Input
                  id="password-confirm"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  onBlur={() => setConfirmTouched(true)}
                />
                {confirmTouched && confirmPassword !== password && (
                  <p className="text-destructive text-sm">Passwords do not match</p>
                )}
              </div>
              {regError && <p className="text-destructive text-sm">{regError}</p>}
              <Button type="submit" className="w-full" disabled={busy || confirmPassword !== password}>
                {busy ? "Creating account…" : "Create admin account"}
              </Button>
            </form>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <p className="text-muted-foreground text-sm">
                Install a coding-agent CLI and switch it on to run real sessions. You can change this later in Settings
                — a blank default profile is already set up for every harness.
              </p>
              {/* First-run dead-end fix: while the registry is in flight the
                  step used to show nothing, and an error left it blank forever. */}
              {harnessesLoading && <p className="text-muted-foreground text-sm">Loading harnesses…</p>}
              {harnessesError && (
                <ErrorBanner
                  message="Couldn't load harnesses."
                  className="rounded-md border"
                  action={
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-inherit text-xs underline"
                      onClick={() => void recheck()}
                    >
                      Retry
                    </Button>
                  }
                />
              )}
              {harnesses?.map((h) => (
                <HarnessRow
                  key={h.id}
                  harness={h}
                  pending={togglePending}
                  error={harnessErrors[h.id]}
                  onToggle={toggleHarness}
                  onRecheck={recheck}
                />
              ))}
              {/* First-run escape hatch (spec §8): a host with no usable
                  harness is not a dead end — sessions can run on an enrolled
                  node instead. "Usable" = installed AND enabled. */}
              {harnesses !== undefined && !harnesses.some((h) => h.installed && h.enabled) && (
                <p className="text-muted-foreground text-sm">
                  Nothing usable on this machine?{" "}
                  <Link to="/nodes" className="underline">
                    …or register a Node →
                  </Link>
                </p>
              )}
              <Button className="w-full" disabled={busy} onClick={finish}>
                Finish setup
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
