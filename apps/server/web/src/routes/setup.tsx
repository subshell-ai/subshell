import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Bot, KeyRound, Rocket } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { AgentRow } from "@/components/setup/agent-row";
import { SetupAssistant } from "@/components/setup/setup-assistant";
import {
  canSubmit,
  emptyNewSubshellForm,
  NewSubshellForm,
  type NewSubshellFormValue,
} from "@/components/subshell-picker/new-subshell-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCreateSubshell } from "@/hooks/use-create-subshell";
import { useHarnesses } from "@/hooks/use-harnesses";
import { useInstallAgent } from "@/hooks/use-install-agent";
import { apiFetch, errMessage } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { createSubshellErrorMessage } from "@/lib/create-subshell-error";
import { desktopPlatform, isDesktop } from "@/lib/desktop";
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

  // Add an Agent: a detection-first list, no toggle. Every harness's install
  // is a separate step (Settings → Plugins); this screen only says what's on
  // this host right now, and refreshes on its own so an install made in a
  // terminal beside it shows up without a control.
  const install = useInstallAgent();
  const installingId = install.isPending ? install.variables : undefined;
  const {
    data: harnesses,
    isLoading: harnessesLoading,
    isError: harnessesError,
    refetch: refetchHarnesses,
  } = useHarnesses({ refetchInterval: step === 1 && !install.isPending ? 4000 : undefined });
  const agents = (harnesses ?? []).filter((h) => h.type === "agent-harness");

  // Launch step. The form defaults itself (node `local`, the first launchable
  // profile, the node's home directory), so this is one click unless the user
  // wants it to be more.
  const [launchForm, setLaunchForm] = useState<NewSubshellFormValue>(emptyNewSubshellForm);
  const create = useCreateSubshell();
  // Set by `launch` BEFORE the cache retirement. Retiring setup-status is what
  // bounces a visitor to "/" via the effect below — a visitor. A user who just
  // LAUNCHED is going to their subshell, and while the cache says setup is
  // done the bounce effect is armed underneath that navigation: if the target
  // route is still loading when the write's re-render commits, the effect
  // fires a second navigate that competes with the first and could land the
  // user on the dashboard instead. In tests it never reproduces (routes
  // resolve synchronously), so this guard is named as such rather than
  // red-pinned; what it guarantees is that the bounce can never arm for a
  // launch.
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

  // In the desktop shell the native assistant already showed three screens;
  // the dot row continues from there so the two programs read as one
  // (spec § 4).
  const NATIVE_STEPS = isDesktop() ? 3 : 0;
  const dotsFor = (n: number) => ({
    total: STEPS.length + NATIVE_STEPS,
    done: NATIVE_STEPS + n,
    current: NATIVE_STEPS + n,
  });
  const here = desktopPlatform() === "macos" ? "this Mac" : "this machine";

  if (step === 0) {
    return (
      <SetupAssistant
        illustration={<KeyRound />}
        title="Create Your Account"
        subtitle={
          isDesktop()
            ? `Subshell Server is running on ${here}. This is its admin account.`
            : "Welcome to Subshell. This is the admin account for your Subshell server."
        }
        dots={dotsFor(0)}
        primary={{
          label: "Create Account",
          onClick: () => void register(),
          disabled: busy || !name || !email || password.length < 8 || confirmPassword !== password,
          pending: busy,
          pendingLabel: "Creating account…",
        }}
      >
        <form
          className="mx-auto grid w-[360px] gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void register();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
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
          </div>
          {confirmTouched && confirmPassword !== password && (
            <p className="text-destructive text-sm">Passwords do not match</p>
          )}
          {regError && <p className="text-destructive text-sm">{regError}</p>}
        </form>
      </SetupAssistant>
    );
  }

  if (step === 1) {
    return (
      <SetupAssistant
        illustration={<Bot />}
        title="Add an Agent"
        subtitle="A plain terminal is always available with nothing to install. Add an agent CLI now, or later in Settings."
        dots={dotsFor(1)}
        primary={{ label: "Continue", onClick: () => setStep(2), disabled: busy }}
      >
        {harnessesLoading && <p className="text-muted-foreground text-sm">Checking {here}…</p>}
        {harnessesError && (
          <ErrorBanner
            message="Couldn't check for agents."
            className="rounded-md border"
            action={
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-inherit text-xs underline"
                onClick={() => void refetchHarnesses()}
              >
                Retry
              </Button>
            }
          />
        )}
        <ul>
          {agents.map((h) => (
            <AgentRow
              key={h.id}
              harness={h}
              onInstall={(id) => install.mutate(id)}
              installing={installingId === h.id}
            />
          ))}
        </ul>
        {install.data && !install.data.ok && (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-muted-foreground">Installer output</summary>
            <pre className="max-h-48 overflow-auto text-xs">{install.data.output}</pre>
          </details>
        )}
        {install.error && (
          <p className="mt-4 text-destructive text-sm">{errMessage(install.error, "Failed to install the agent")}</p>
        )}
        {harnesses !== undefined && !agents.some((h) => h.installed) && (
          <p className="mt-4 text-muted-foreground text-sm">
            Nothing on {here}?{" "}
            <Link to="/nodes" className="underline">
              …or register a Node →
            </Link>
          </p>
        )}
      </SetupAssistant>
    );
  }

  return (
    <SetupAssistant
      illustration={<Rocket />}
      title="Start Your First Subshell"
      subtitle="Everything below is already filled in. Change anything you like."
      dots={dotsFor(2)}
      skip={{ label: "Skip", onClick: finish, disabled: create.isPending }}
      primary={{
        label: "Start",
        onClick: () => void launch(),
        disabled: create.isPending || !canSubmit(launchForm),
        pending: create.isPending,
        pendingLabel: "Starting…",
      }}
    >
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
        <p className="mt-3 text-destructive text-sm">
          {createSubshellErrorMessage(create.error, "Failed to start the subshell")}
        </p>
      )}
    </SetupAssistant>
  );
}
