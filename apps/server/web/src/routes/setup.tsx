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
import { NetworkStep } from "@/components/setup/network-step";
import { SetupAssistant } from "@/components/setup/setup-assistant";
import { TmuxRow } from "@/components/setup/tmux-row";
import {
  canSubmit,
  emptyNewSubshellForm,
  NewSubshellForm,
  type NewSubshellFormValue,
} from "@/components/subshell-picker/new-subshell-form";
import { Button } from "@/components/ui/button";
import { useAdminStatus } from "@/hooks/use-admin-status";
import { useCreateSubshell } from "@/hooks/use-create-subshell";
import { useHarnesses } from "@/hooks/use-harnesses";
import { useInstallAgent } from "@/hooks/use-install-agent";
import { useInstallTmux } from "@/hooks/use-install-tmux";
import { useSetSetupProgress, useSetupProgress } from "@/hooks/use-setup-progress";
import { apiFetch, errMessage } from "@/lib/api";
import { useCurrentUser } from "@/lib/auth";
import { authClient } from "@/lib/auth-client";
import { createSubshellErrorMessage } from "@/lib/create-subshell-error";
import { desktopPlatform, isServerDesktop } from "@/lib/desktop";
import { CURRENT_USER_QUERY_KEY } from "@/lib/query-keys";
import type { SetupStep } from "@/types/setup";

export const Route = createFileRoute("/setup")({
  component: SetupPage,
});

/**
 * The wizard's own screens, in order. The Network step sits SECOND — before
 * the agent — because it is about reaching this server at all, and a person
 * who is going to open the dashboard on their phone wants that decided before
 * they start choosing what runs on it. It is optional, and skipping it costs
 * nothing: every act on it is on `/settings/networking` afterwards.
 */
const STEPS = ["Account", "Network", "Agent", "Launch"] as const;

/**
 * The wizard screen a bookmark names, or 0 (Account) for none.
 *
 * `account` is deliberately unaddressable: the wizard's first screen creates
 * the account, so the earliest a bookmark can exist is the screen AFTER it
 * (`spec 2026-09-16` §2.1).
 *
 * @param step - the caller's bookmark, `GET /api/setup/progress`'s `step`
 */
function stepFromBookmark(step: SetupStep | null | undefined): number {
  switch (step) {
    case "network":
      return 1;
    case "agent":
      return 2;
    case "launch":
      return 3;
    default:
      return 0;
  }
}

/**
 * The wizard screen a NAVIGATION onto index `n` must bookmark.
 *
 * The bookmark names the step to REOPEN on — the step the person is arriving
 * at, so leaving and reopening resumes exactly there. The Account step is not
 * reachable by a nav write: advancing to it from registration is the sign-up
 * hook's job (it writes `network`, the FIRST resumable screen), and the walk
 * never goes back to it. Returns undefined for the account step so callers
 * skip the write rather than store a step that cannot resume.
 *
 * @param n - the wizard index navigated TO
 */
function bookmarkFor(n: number): SetupStep | undefined {
  return n === 1 ? "network" : n === 2 ? "agent" : n === 3 ? "launch" : undefined;
}

function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => apiFetch<{ needsSetup: boolean }>("/api/setup/status"),
  });
  // The wizard gates its bookmark read on a live session — a bookmark
  // presupposes a user (there is no no-users carve-out on the route), so a
  // first-run visitor fires no doomed request. It reads the SAME
  // `setup-progress` query the root shell holds first paint on, so a resumed
  // landing has the answer already cached (spec 2026-09-16 §2.4).
  const { data: currentUser } = useCurrentUser();
  const { data: progress } = useSetupProgress(!!currentUser);
  const setProgress = useSetSetupProgress();
  // The step opens ON the bookmark where there is one; a first-run visitor
  // (no session, no bookmark) starts on Account as before.
  const [step, setStep] = useState(() => stepFromBookmark(progress?.step));
  // Registration (better-auth sign-up). The fields are the shared
  // `NewAccountFields` — the same form the admin's Add user dialog renders —
  // so this screen holds one value and none of the rules about it.
  const [account, setAccount] = useState<NewAccountValue>(EMPTY_NEW_ACCOUNT);
  const [regError, setRegError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A bookmark arriving after mount (a direct load of /setup where the read
  // was not yet cached): apply it ONLY while still on the account screen and
  // nothing has been typed, so a late answer never yanks someone who has
  // already begun. `account === EMPTY_NEW_ACCOUNT` is exact — the shared form
  // replaces the whole value on any edit, so the reference is the untouched
  // constant until the first keystroke.
  useEffect(() => {
    const target = stepFromBookmark(progress?.step);
    if (step === 0 && target > 0 && account === EMPTY_NEW_ACCOUNT) setStep(target);
  }, [progress?.step, step, account]);

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
  /**
   * tmux on the control-plane host, and the installer for it.
   *
   * Detection rides the admin status read rather than a route of its own —
   * step 0 created the admin account, so a cookie exists by the time this
   * screen mounts, and `runtime.tmuxPath` is the same fact Settings → Status
   * shows. Enabled from step 1 for that reason: on step 0 there is no session
   * and the request would 403. (Step 1 is the Network screen now, which does
   * not read it — the gate is about when a cookie EXISTS, not about which
   * screen wants the answer.)
   */
  const { data: adminStatus } = useAdminStatus(step >= 1);
  const [tmuxLine, setTmuxLine] = useState<string | undefined>(undefined);
  const installTmux = useInstallTmux((line) => {
    // Blank lines are spacing in an installer's output, not progress; showing
    // one would blank the only thing on screen that was saying anything.
    if (line.trim() !== "") setTmuxLine(line);
  });
  /**
   * The last tmux install attempt's failure, or undefined when it worked.
   *
   * THREE failures, not two. The call itself failing and a command that ran
   * and exited non-zero are the same pair the agent rows have — but a package
   * manager can also exit ZERO having installed into a directory this server
   * process cannot see, which is exactly what the CLI's own offer re-probes
   * for. Reporting that as success would leave the row saying "Not found"
   * under a green install with nothing explaining the contradiction.
   */
  const tmuxFailure = installTmux.error
    ? { message: errMessage(installTmux.error, "Couldn't install tmux.") }
    : installTmux.data && !installTmux.data.ok
      ? {
          message:
            installTmux.data.exitCode === null
              ? "The installer could not be started."
              : `The installer exited with code ${installTmux.data.exitCode}.`,
          output: installTmux.data.output,
        }
      : installTmux.data && installTmux.data.tmuxPath === null
        ? {
            message: "The installer finished, but tmux is still not on this server's PATH.",
            output: installTmux.data.output,
          }
        : undefined;
  const {
    data: harnesses,
    isLoading: harnessesLoading,
    isError: harnessesError,
    refetch: refetchHarnesses,
  } = useHarnesses({ refetchInterval: step === 2 && !install.isPending ? 4000 : undefined });
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

  // A visitor, and ONLY a visitor, bounces. Before the resume bookmark
  // (spec 2026-09-16) this was `needsSetup === false && !launchedRef` — which
  // read the account's existence as "setup done", because the account is
  // created on the FIRST screen. Now a signed-in first admin whose bookmark
  // names a step IS the resumed wizard, not a visitor, and the `step === 0`
  // guard makes the whole stale-setup-status window irrelevant: once anyone
  // has moved off Account they are not bounced.
  const resumeSetup = progress?.step != null;
  useEffect(() => {
    if (status?.needsSetup === false && step === 0 && !resumeSetup && !launchedRef.current) {
      navigate({ to: "/" });
    }
  }, [status, step, resumeSetup, navigate]);

  if (!status) return null;

  /**
   * Moves the wizard to step `n` and bookmarks it.
   *
   * Fire-and-forget (spec 2026-09-16 §2.3): the optimistic cache write in
   * `useSetSetupProgress` is what the root gate reads on the re-render, so the
   * wizard never contradicts itself; a failed PATCH costs a resume at the
   * PREVIOUS step, the harmless direction, so the error is deliberately not
   * surfaced. Account (n=0) writes nothing — advancing to Network is the
   * sign-up hook's job, and the walk never returns to Account.
   */
  function goTo(n: number) {
    setStep(n);
    const bookmark = bookmarkFor(n);
    if (bookmark) setProgress.mutate(bookmark);
  }

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
    // Finish and launch both CLEAR the bookmark (spec 2026-09-16 §2.3): a
    // completed wizard must not reopen, and this also retracts the optimistic
    // `launch` write so a reopen lands on the dashboard, not a spent wizard.
    setProgress.mutate(null);
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
        title="Connect a Network"
        subtitle={
          <>
            Reach this server from your other devices over a network you already use. This step is optional — you can
            set it up later under <span className="font-strong">Settings → Networking</span>.
          </>
        }
        dots={dotsFor(1)}
        skip={{ label: "Skip for now", onClick: () => goTo(2) }}
        primary={{ label: "Continue", onClick: () => goTo(2) }}
      >
        <NetworkStep active={step === 1} />
      </SetupAssistant>
    );
  }

  if (step === 2) {
    return (
      <SetupAssistant
        key={step}
        title="Add an Agent"
        subtitle="A plain terminal is always available with nothing to install. Add an agent CLI now, or later in Settings."
        dots={dotsFor(2)}
        // Back reaches the Network screen, which is the one a person most
        // wants a second look at: it is skippable, it is where "open this on
        // my phone" is answered, and skipping it used to be irreversible
        // short of restarting the wizard. It carries the primary's disabled
        // condition for the primary's reason — an install in flight must not
        // be walked out of in either direction. There is deliberately no Back
        // to the account screen from Network: step 0 advances only once
        // `signUp` has SUCCEEDED, so that form is for an account that exists.
        back={{ onClick: () => goTo(1), disabled: busy || install.isPending || installTmux.isPending }}
        // An install is a `curl … | bash` on this machine that takes tens of
        // seconds. Continuing out from under it left the progress line and any
        // failure on a screen nobody was looking at any more, and the next
        // step's agent list was already stale — so the press waits, and the
        // bar says what for (operator report, 2026-09-14).
        primary={{
          label: "Continue",
          onClick: () => goTo(3),
          disabled: busy || install.isPending || installTmux.isPending,
        }}
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
          {/* Pinned above the agents, and deliberately in the same list: the
              question is the same one — what is on this machine — and tmux is
              the one answer that decides whether anything can launch here at
              all. It never blocks Continue; the launch step refuses honestly
              on its own. */}
          <TmuxRow
            tmuxPath={adminStatus?.runtime.tmuxPath}
            os={adminStatus?.runtime.os}
            onInstall={() => installTmux.mutate()}
            installing={installTmux.isPending}
            progress={tmuxLine}
            failure={installTmux.isPending ? undefined : tmuxFailure}
          />
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
      dots={dotsFor(3)}
      // Disabled while the launch is in flight, exactly as Skip is: the
      // subshell is already being created and leaving would orphan the report.
      back={{ onClick: () => goTo(2), disabled: create.isPending }}
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
