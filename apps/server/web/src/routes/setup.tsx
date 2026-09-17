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
import { TmuxStep } from "@/components/setup/tmux-step";
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
 * A wizard screen. `account` is the only one a bookmark can never name — the
 * first screen CREATES the account, so the earliest resumable point is the
 * screen after it (spec 2026-09-16 § 2.1). Excluding it from `SetupStep` is
 * what makes `goTo`'s write total: every non-account screen's id IS its
 * bookmark, so there is no second table to keep in step.
 */
type WizardStep = "account" | SetupStep;

/**
 * The wizard's screens in order. The Network step sits SECOND — before tmux
 * and the agent — because it is about reaching this server at all, and a
 * person who is going to open the dashboard on their phone wants that decided
 * before they start choosing what runs on it. It is optional, and skipping it
 * costs nothing: every act on it is on `/settings/networking` afterwards.
 *
 * The Tmux step sits third (spec 2026-09-15 § 5.1, as amended 2026-09-17):
 * tmux is what every pane on this machine runs inside, and until this step it
 * rode as the first row of the agent list — where it read as an agent named
 * tmux, under a subtitle promising "A plain terminal is always available with
 * nothing to install".
 *
 * The step is ABSENT inside Subshell Server: the native assistant shows its
 * own tmux screen on every first run (`wizard-state.ts screensFor`), and it
 * can ACT on a missing tmux through brew and pkexec, where the SPA's
 * `POST /api/setup/tmux/install` is Homebrew-only and 409s on every Linux
 * entry. A browser (and Subshell Client, whose plane is somebody else's
 * machine) gets the step, and the dot row gains one — inside the server app
 * the assistant's screens already carry that dot, which is what keeps
 * {@link dotsFor} totals identical to before for that shell.
 */
const STEP_ORDER: readonly WizardStep[] = ["account", "network", "tmux", "agent", "launch"];

/** The same list as the Subshell Server assistant hands off to: no Tmux step. */
const SERVER_DESKTOP_STEPS: readonly WizardStep[] = STEP_ORDER.filter((s) => s !== "tmux");

/**
 * The wizard screen a bookmark names, or `account` for none.
 *
 * A bookmark naming a step the ACTIVE list lacks resolves FORWARD to the next
 * step that exists — today that is only `"tmux"` read inside Subshell Server,
 * where the screen is the assistant's. The bookmark survives the shell switch
 * rather than being discarded: the step it resolves to is exactly where the
 * person still has to go, and clearing it would silently restart a wizard
 * that was only seen through a different shell.
 *
 * `account` is deliberately unaddressable: see {@link WizardStep}.
 *
 * @param step - the caller's bookmark, `GET /api/setup/progress`'s `step`
 * @param steps - the screens this shell actually renders
 */
function stepFromBookmark(step: SetupStep | null | undefined, steps: readonly WizardStep[]): WizardStep {
  if (!step) return "account";
  const wanted = STEP_ORDER.indexOf(step);
  for (const candidate of steps) {
    if (STEP_ORDER.indexOf(candidate) >= wanted) return candidate;
  }
  // A bookmark past the end of the list — unreachable today, since every
  // shell keeps the launch step. `account` is the fail-safe: the effect that
  // applies a late bookmark only acts from `account`, so the worst case is
  // the screen a first-run visitor is already on.
  return "account";
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
  // Which screens THIS shell walks — module-level constants so the identity
  // is stable and `stepFromBookmark` gets the same list every call.
  const steps = isServerDesktop() ? SERVER_DESKTOP_STEPS : STEP_ORDER;
  // The step opens ON the bookmark where there is one; a first-run visitor
  // (no session, no bookmark) starts on Account as before.
  const [step, setStep] = useState<WizardStep>(() => stepFromBookmark(progress?.step, steps));
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
    const target = stepFromBookmark(progress?.step, steps);
    if (step === "account" && target !== "account" && account === EMPTY_NEW_ACCOUNT) setStep(target);
  }, [progress?.step, step, account, steps]);

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
   * tmux on the control-plane host, and the installer for it — the Tmux
   * step's whole subject (spec 2026-09-15 § 5.1, as amended 2026-09-17).
   *
   * Detection rides the admin status read rather than a route of its own —
   * step `account` created the admin account, so a cookie exists by the time
   * any later screen mounts, and `runtime.tmuxPath` is the same fact
   * Settings → Status shows. Enabled from the first screen after account for
   * that reason: on account there is no session and the request would 403.
   * (The Network screen does not read it either — the gate is about WHEN a
   * cookie EXISTS, not about which screen wants the answer, and starting the
   * read a screen early is what makes it warm when the Tmux step mounts.)
   * Inside Subshell Server the read never runs: the step it feeds is absent
   * there, and its assistant answers the same question from the CLI.
   */
  const { data: adminStatus } = useAdminStatus(step !== "account" && steps.includes("tmux"));
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
   * for. Reporting that as success would leave the step saying "Not found"
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
  } = useHarnesses({ refetchInterval: step === "agent" && !install.isPending ? 4000 : undefined });
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
  // names a step IS the resumed wizard, not a visitor, and the account guard
  // makes the whole stale-setup-status window irrelevant: once anyone has
  // moved off Account they are not bounced.
  const resumeSetup = progress?.step != null;
  useEffect(() => {
    if (status?.needsSetup === false && step === "account" && !resumeSetup && !launchedRef.current) {
      navigate({ to: "/" });
    }
  }, [status, step, resumeSetup, navigate]);

  if (!status) return null;

  /**
   * Moves the wizard to `target` and bookmarks it.
   *
   * Fire-and-forget (spec 2026-09-16 §2.3): the optimistic cache write in
   * `useSetSetupProgress` is what the root gate reads on the re-render, so the
   * wizard never contradicts itself; a failed PATCH costs a resume at the
   * PREVIOUS step, the harmless direction, so the error is deliberately not
   * surfaced. Account writes nothing — advancing to the next step is the
   * sign-up hook's job (the server's first-admin promotion bookmarks
   * `network`, the FIRST resumable screen), and the walk never goes back to
   * it. Excluding `"account"` narrows `target` to exactly `SetupStep`, so the
   * screen id and the wire value are one thing, never two tables.
   */
  function goTo(target: WizardStep) {
    setStep(target);
    if (target !== "account") setProgress.mutate(target);
  }

  const index = steps.indexOf(step);
  /** The step this shell's Back button walks to — the previous one it renders. */
  function goBack() {
    const target = steps[index - 1];
    if (target) goTo(target);
  }
  /** The step this shell's Continue walks to — the next one it renders. */
  function goNext() {
    const target = steps[index + 1];
    if (target) goTo(target);
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
      // NOT `goTo`: the server's first-admin promotion already bookmarked the
      // first resumable step in the same transaction that created the row;
      // re-writing it here would be a second writer to the bookmark at the
      // one moment the two could disagree about whether a session exists.
      // `network` is the step after account in BOTH shells.
      setStep("network");
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
  // The assistant's set INCLUDES its tmux screen, which is what lets this
  // shell cut the SPA's step without moving any dot: the person has already
  // been shown that screen, under this same dot row, minutes earlier.
  const NATIVE_STEPS = isServerDesktop() ? (desktopPlatform() === "macos" ? 4 : 3) : 0;
  const dotsFor = (s: WizardStep) => {
    const here = steps.indexOf(s);
    return { total: steps.length + NATIVE_STEPS, done: NATIVE_STEPS + here, current: NATIVE_STEPS + here };
  };
  // One string on both platforms (operator's call, 2026-09-12): the native
  // assistant that hands off to these screens dropped its own "this Mac"
  // variant, and the two halves of one flow must not differ in voice.
  const here = "this machine";

  if (step === "account") {
    return (
      <SetupAssistant
        key={step}
        title="Create Your Account"
        subtitle={
          isServerDesktop()
            ? `Subshell Server is running on ${here}. This is its admin account.`
            : "Welcome to Subshell. This is the admin account for your Subshell server."
        }
        dots={dotsFor(step)}
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

  if (step === "network") {
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
        dots={dotsFor(step)}
        skip={{ label: "Skip for now", onClick: goNext }}
        primary={{ label: "Continue", onClick: goNext }}
      >
        <NetworkStep active={step === "network"} />
      </SetupAssistant>
    );
  }

  if (step === "tmux") {
    return (
      <SetupAssistant
        key={step}
        title="Install tmux"
        subtitle={`tmux is what every pane on ${here} runs inside.`}
        dots={dotsFor(step)}
        // Continue is never blocked on tmux being MISSING (spec 2026-09-15
        // § 5.1) — the launch step refuses honestly on its own. What DOES
        // hold the bar is an install in flight: the same rule the agent step
        // has, so a `brew install` taking a minute is never walked out of and
        // its progress line and any failure left on a screen nobody is
        // looking at.
        back={{ onClick: goBack, disabled: installTmux.isPending }}
        primary={{ label: "Continue", onClick: goNext, disabled: installTmux.isPending }}
      >
        <TmuxStep
          tmuxPath={adminStatus?.runtime.tmuxPath}
          os={adminStatus?.runtime.os}
          onInstall={() => installTmux.mutate()}
          installing={installTmux.isPending}
          progress={tmuxLine}
          failure={installTmux.isPending ? undefined : tmuxFailure}
        />
      </SetupAssistant>
    );
  }

  if (step === "agent") {
    return (
      <SetupAssistant
        key={step}
        title="Add an Agent"
        subtitle="A plain terminal is always available with nothing to install. Add an agent CLI now, or later in Settings."
        dots={dotsFor(step)}
        // Back walks the list: the Tmux step in a browser, Network inside the
        // server app. It carries the primary's disabled condition for the
        // primary's reason — an install in flight must not be walked out of
        // in either direction. There is deliberately no Back to the account
        // screen from Network, one step further along the chain: step 0
        // advances only once `signUp` has SUCCEEDED, so that form is for an
        // account that exists.
        back={{ onClick: goBack, disabled: busy || install.isPending }}
        // An install is a `curl … | bash` on this machine that takes tens of
        // seconds. Continuing out from under it left the progress line and any
        // failure on a screen nobody was looking at any more, and the next
        // step's agent list was already stale — so the press waits, and the
        // bar says what for (operator report, 2026-09-14).
        primary={{
          label: "Continue",
          onClick: goNext,
          disabled: busy || install.isPending,
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
        {/* tmux is deliberately NOT a row here (2026-09-17): the operator
            ruled it read as an agent named tmux under a subtitle promising
            one screen that needs nothing installed. It is its own step, two
            dots back in a browser and the assistant's screen inside the
            server app. */}
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
      dots={dotsFor(step)}
      // Disabled while the launch is in flight, exactly as Skip is: the
      // subshell is already being created and leaving would orphan the report.
      back={{ onClick: goBack, disabled: create.isPending }}
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
