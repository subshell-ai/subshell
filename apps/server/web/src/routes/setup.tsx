import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { HarnessRow } from "@/components/harness-row";
import {
  canSubmit,
  emptyNewSubshellForm,
  NewSubshellForm,
  type NewSubshellFormValue,
} from "@/components/subshell-picker/new-subshell-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCreateSubshell } from "@/hooks/use-create-subshell";
import { useHarnessToggles } from "@/hooks/use-harness-toggles";
import { useHarnesses, useRecheckHarnesses } from "@/hooks/use-harnesses";
import { apiFetch } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { createSubshellErrorMessage } from "@/lib/create-subshell-error";
import { CURRENT_USER_QUERY_KEY } from "@/lib/query-keys";

export const Route = createFileRoute("/setup")({
  component: SetupPage,
});

const STEPS = ["Account", "Agent", "Launch"] as const;

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

  // Launch step. The form defaults itself (node `local`, the first launchable
  // profile, the node's home directory), so this is one click unless the user
  // wants it to be more.
  const [launchForm, setLaunchForm] = useState<NewSubshellFormValue>(emptyNewSubshellForm);
  const create = useCreateSubshell();
  // Set by `launch` BEFORE the cache retirement. Retiring setup-status is what
  // bounces a visitor to "/" via the effect below — a visitor. A user who just
  // LAUNCHED is going to their subshell, and the bounce effect must not arm
  // underneath that navigation: completeSetup() re-renders this component with
  // needsSetup:false, and if the target route is still loading at that moment
  // (it does not in tests, where every route resolves synchronously — the
  // guard is NOT pinned by a red-first test because the race does not
  // reproduce here), the effect's navigate("/") is a second navigation
  // competing with the first. Skipping this ref means a launch could land on
  // the dashboard; it means the launch NEVER bounces.
  const launchedRef = useRef(false);

  useEffect(() => {
    if (status?.needsSetup === false && !launchedRef.current) {
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
      queryClient.invalidateQueries({ queryKey: CURRENT_USER_QUERY_KEY });
      setStep(1);
    } catch {
      setRegError("Network error");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Retires the shared setup-status cache.
   *
   * It still says needsSetup:true for its staleTime window (10 s), and the
   * Subshells page reads it on its first render and bounces straight back to
   * /setup, so a wizard finished in under 10 s would be trapped there. Both
   * exits from the last step go through this.
   */
  function completeSetup() {
    queryClient.setQueryData(["setup-status"], { needsSetup: false });
  }

  function finish() {
    completeSetup();
    navigate({ to: "/" });
  }

  /** Launches the first subshell and lands the user in it. */
  async function launch() {
    try {
      const created = await create.mutateAsync(launchForm);
      launchedRef.current = true;
      completeSetup();
      void navigate({ to: "/subshells/$id", params: { id: created.id } });
    } catch {
      // The mutation keeps the error; it renders below the form. Setup is
      // deliberately NOT completed here: the user is still on the step and
      // can retry or skip, and skipping is what finishes.
    }
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
              <div className="space-y-1">
                <p className="font-medium">Add an agent (optional)</p>
                <p className="text-muted-foreground text-sm">
                  Install a coding-agent CLI and switch it on to run agent subshells. You can skip this: a subshell can
                  run a plain terminal, and you can add an agent any time from Settings.
                </p>
              </div>
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
                  harness is not a dead end — subshells can run on an enrolled
                  node instead. "Usable" = this host has the PLUGIN and the
                  PROGRAM it drives was found. */}
              {harnesses !== undefined && !harnesses.some((h) => h.installed && h.installedHere) && (
                <p className="text-muted-foreground text-sm">
                  Nothing usable on this machine?{" "}
                  <Link to="/nodes" className="underline">
                    …or register a Node →
                  </Link>
                </p>
              )}
              <Button className="w-full" disabled={busy} onClick={() => setStep(2)}>
                Continue
              </Button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="space-y-1">
                <p className="font-medium">Start your first subshell</p>
                <p className="text-muted-foreground text-sm">
                  Everything below is already filled in. Change anything you like, or just start it.
                </p>
              </div>

              <NewSubshellForm
                value={launchForm}
                onChange={setLaunchForm}
                ids={{
                  profile: "setup-profile",
                  workingDir: "setup-working-dir",
                  name: "setup-subshell-name",
                  node: "setup-node",
                }}
              />

              {create.error && (
                <p className="text-destructive text-sm">
                  {createSubshellErrorMessage(create.error, "Failed to start the subshell")}
                </p>
              )}

              <Button
                className="w-full"
                disabled={create.isPending || !canSubmit(launchForm)}
                onClick={() => void launch()}
              >
                {create.isPending ? "Starting…" : "Start my first subshell"}
              </Button>

              {/* Never a dead end: a machine that cannot launch anything must
                  still be able to leave the wizard and reach the app. */}
              <Button variant="link" className="w-full" disabled={create.isPending} onClick={finish}>
                Skip for now
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
