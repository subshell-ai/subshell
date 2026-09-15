import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  EMPTY_NEW_ACCOUNT,
  NewAccountFields,
  type NewAccountValue,
  newAccountComplete,
  normalizeNewAccount,
} from "@/components/account/new-account-fields";
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
import { useCreateSubshell } from "@/hooks/use-create-subshell";
import { useHarnesses } from "@/hooks/use-harnesses";
import { useInstallAgent } from "@/hooks/use-install-agent";
import { apiFetch, errMessage } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { createSubshellErrorMessage } from "@/lib/create-subshell-error";
import { desktopPlatform, isServerDesktop } from "@/lib/desktop";
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

  // Registration (better-auth sign-up). The fields are the shared
  // `NewAccountFields` — the same form the admin's Add user dialog renders —
  // so this screen holds one value and none of the rules about it.
  const [account, setAccount] = useState<NewAccountValue>(EMPTY_NEW_ACCOUNT);
  const [regError, setRegError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Add an Agent: a detection-first list, no toggle. Every harness's install
  // is a separate step (Settings → Plugins); this screen only says what's on
  // this host right now, and refreshes on its own so an install made in a
  // terminal beside it shows up without a control.
  /**
   * The installer's latest line, per agent id.
   *
   * Kept out here rather than in the row so it survives the row re-rendering
   * on every frame, and keyed by id so a second install never shows the
   * first one's output.
   */
  const [installLines, setInstallLines] = useState<Record<string, string>>({});
  const install = useInstallAgent((id, line) => {
    // Blank lines are spacing in an installer's output, not progress; showing
    // one would blank the only thing on screen that was saying anything.
    if (line.trim() !== "") setInstallLines((prev) => ({ ...prev, [id]: line }));
  });
  const installingId = install.isPending ? install.variables : undefined;
  /**
   * The last install attempt's failure, or undefined when the last one worked.
   *
   * Two different failures, said differently: the call itself failing (the
   * server refused, the network went) is `install.error`, while a command
   * that RAN and exited non-zero comes back `ok: false` with the installer's
   * own output — which is the case worth showing, and which used to be
   * offered as a collapsed "Installer output" with no sentence saying the
   * install had failed at all.
   */
  const installFailure = install.error
    ? { message: errMessage(install.error, "Couldn't run the installer.") }
    : install.data && !install.data.ok
      ? {
          message:
            install.data.exitCode === null
              ? "The installer could not be started."
              : `The installer exited with code ${install.data.exitCode}.`,
          output: install.data.output,
        }
      : undefined;
  const {
    data: harnesses,
    isLoading: harnessesLoading,
    isError: harnessesError,
    refetch: refetchHarnesses,
  } = useHarnesses({ refetchInterval: step === 1 && !install.isPending ? 4000 : undefined });
  const agents = (harnesses ?? []).filter((h) => h.type === "agent-harness");

  // Launch step. The form defaults itself (node `local`, a usable agent, the
  // node's home directory), so this is one click unless the user wants it to
  // be more.
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
      // The same normalization the Add user dialog submits with. It matters
      // more here than there: `POST /api/users` trims the name server-side,
      // and this screen does not go through that route — better-auth stores
      // what it is handed, so first run is the one path where a name typed
      // with spaces keeps them.
      const submitted = normalizeNewAccount(account);
      const { error: signUpError } = await authClient.signUp.email({
        name: submitted.name,
        email: submitted.email,
        password: submitted.password,
      });
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

  // In the desktop shell the native assistant already showed its screens; the
  // dot row continues from there so the two programs read as one (spec § 4).
  // macOS gets a fourth — "What macOS Will Ask" sits between Install tmux and
  // Set Up, and exists only on the platform that asks (spec 2026-09-14 §6).
  const NATIVE_STEPS = isServerDesktop() ? (desktopPlatform() === "macos" ? 4 : 3) : 0;
  const dotsFor = (n: number) => ({
    total: STEPS.length + NATIVE_STEPS,
    done: NATIVE_STEPS + n,
    current: NATIVE_STEPS + n,
  });
  // One string on both platforms (operator's call, 2026-09-12): the native
  // assistant that hands off to these screens dropped its own "this Mac"
  // variant, and the two halves of one flow must not differ in voice.
  const here = "this machine";

  if (step === 0) {
    return (
      <SetupAssistant
        key={step}
        title="Create Your Account"
        subtitle={
          isServerDesktop()
            ? `Subshell Server is running on ${here}. This is its admin account.`
            : "Welcome to Subshell. This is the admin account for your Subshell server."
        }
        dots={dotsFor(0)}
        primary={{
          label: "Create Account",
          onClick: () => void register(),
          disabled: busy || !newAccountComplete(account),
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
          <NewAccountFields value={account} onChange={setAccount} autoFocus />
          {regError && <p className="text-destructive text-sm">{regError}</p>}
        </form>
      </SetupAssistant>
    );
  }

  if (step === 1) {
    return (
      <SetupAssistant
        key={step}
        title="Add an Agent"
        subtitle="A plain terminal is always available with nothing to install. Add an agent CLI now, or later in Settings."
        dots={dotsFor(1)}
        // An install is a `curl … | bash` on this machine that takes tens of
        // seconds. Continuing out from under it left the progress line and any
        // failure on a screen nobody was looking at any more, and the next
        // step's agent list was already stale — so the press waits, and the
        // bar says what for (operator report, 2026-09-14).
        primary={{ label: "Continue", onClick: () => setStep(2), disabled: busy || install.isPending }}
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
                className="h-auto p-0 text-detail text-inherit underline"
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
              progress={installLines[h.id]}
              // A failure belongs to the row that produced it. `variables` is
              // the id the last mutation ran with, which is what ties the
              // result back to an agent — the old placement, under the whole
              // list, named none of them.
              failure={!install.isPending && install.variables === h.id ? installFailure : undefined}
            />
          ))}
        </ul>
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
      key={step}
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
        firstRun
        ids={{
          agent: "setup-agent",
          preset: "setup-preset",
          workingDir: "setup-working-dir",
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
