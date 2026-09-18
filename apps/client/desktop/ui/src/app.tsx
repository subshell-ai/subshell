/**
 * Subshell Client's bundled page — the `node` window, as an assistant.
 *
 * NOT the app's only window. `main` shows a control plane's own UI, loaded
 * from the plane's own origin and granted exactly one command (open a page of
 * that plane in the system browser); this page is the other half, and the only
 * surface that drives the `subshell` CLI.
 *
 * **The first run asks what you came to do** (spec 2026-09-18). A fresh
 * install walks Welcome → Choice → either *register this machine as a node*
 * (tmux → Register → how it runs → Setting Up…) or *connect to a server*, and
 * a machine that is already set up lands on the client **status** screen on
 * every launch afterwards. The load-bearing rule the whole flow exists for:
 * **the server's dashboard is never opened during setup** — it opens from the
 * status screen's own button, once there is something to open it for.
 *
 * This file is the HOST and nothing else: it reads the machine
 * (`use-node-state`), holds the action runner, the enrol form and the walk's
 * own state, asks `clientScreen` which screen to draw, and composes the shared
 * half of the frame — title, subtitle, the problem line and the confirmation.
 * Each screen owns its own icon, content and bottom bar. Every routing
 * decision lives in `lib/client-flow.ts`, where it is testable without a
 * webview.
 */
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { AboutScreen } from "@/components/assistant/about-screen";
import { AppUpdateScreen } from "@/components/assistant/app-update-screen";
import { ChoiceScreen } from "@/components/assistant/choice-screen";
import { ConnectScreen } from "@/components/assistant/connect-screen";
import { EnrollScreen } from "@/components/assistant/enroll-screen";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { ProgressScreen } from "@/components/assistant/progress-screen";
import { RegisterScreen } from "@/components/assistant/register-screen";
import { ResetScreen } from "@/components/assistant/reset-screen";
import { StartupScreen } from "@/components/assistant/startup-screen";
import { StatusScreen } from "@/components/assistant/status-screen";
import { subtitleFor } from "@/components/assistant/subtitles";
import { TmuxScreen } from "@/components/assistant/tmux-screen";
import { WelcomeScreen } from "@/components/assistant/welcome-screen";
import { ConfirmPanel } from "@/components/confirm-panel";
import { Button } from "@/components/ui/button";
import { useActionRunner } from "@/hooks/use-action-runner";
import { useEnrollForm } from "@/hooks/use-enroll-form";
import { useNodeCommands } from "@/hooks/use-node-commands";
import { useNodeState } from "@/hooks/use-node-state";
import {
  clientScreen,
  configured,
  type FteStep,
  type RegisterPhase,
  type RegisterRow,
  registerSteps,
} from "@/lib/client-flow";
import type { ActionResult, EnrolledNodeBody } from "@/lib/ipc";
import * as ipc from "@/lib/ipc";
import { type NodeUserScreen, screenTitle } from "@/lib/node-assistant-state";

export function App() {
  const runner = useActionRunner();
  const { probe, settings, firstProbePending, readError } = useNodeState(runner.busy);
  const form = useEnrollForm();

  /** A screen the USER chose rather than one the machine implies. */
  const [override, setOverride] = useState<NodeUserScreen | null>(null);
  /** Which phase of the first-run walk is in progress, or null for no walk. */
  const [step, setStep] = useState<FteStep | null>(null);
  /**
   * Whether the node's service is armed for login.
   *
   * Answered on the start-up screen and handed to the register chain's LAST
   * act, because `service install` is what the answer parameterizes. Defaults
   * to on, which is what the agent has always done.
   */
  const [startAtLogin, setStartAtLogin] = useState(true);
  /** How far the register chain has got, for the Setting Up… checklist. */
  const [phase, setPhase] = useState<RegisterPhase>("form");
  /** Which act of that chain failed, if one did. */
  const [failedAct, setFailedAct] = useState<RegisterRow["id"] | null>(null);

  // The tray's own route into this page. One event, one name, and an id this
  // build does not know is IGNORED rather than throwing — that is what lets a
  // menu item and this page ship independently.
  useEffect(() => {
    // ASK first: this window may have just been created by the tray's About,
    // in which case the emit below was never heard — the page's listener
    // registers over IPC after the module evaluates, and Tauri queues nothing
    // for a window that is not listening yet. A window that was already up is
    // told directly, and whichever path gets there takes the request once.
    void ipc
      .nodePendingScreen()
      .then((pending) => {
        if (pending === "about" || pending === "app-update") setOverride(pending);
      })
      .catch(() => {
        // An older Rust half knows no such command; nothing was requested that
        // this page can honour.
      });
    const unlisten = listen<string>("desktop-screen", (event) => {
      if (event.payload === "about" || event.payload === "app-update") setOverride(event.payload);
    });
    return () => {
      // Both halves swallow: a subscription that never came up has nothing to
      // tear down, and a teardown that races the window going away must not
      // become an unhandled rejection.
      void unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  /**
   * Leave the watch walk once the address has actually landed.
   *
   * `connectOnly` persists and the runner refetches the settings, so the walk
   * ends on the FACT rather than on the press: clearing the step optimistically
   * would route a not-yet-configured machine straight back to Welcome for one
   * frame, and the walk deliberately outranks `configured`, so it cannot end
   * itself.
   */
  useEffect(() => {
    if (step === "watch" && configured(settings, probe)) setStep(null);
  }, [step, settings, probe]);

  /**
   * The `enroll --json` body from a successful enrollment in THIS session —
   * the only place the node's display NAME is knowable, since `status --json`
   * reports no name and `config.json`'s is not among the facts Rust hands out.
   */
  const [enrolledNode, setEnrolledNode] = useState<EnrolledNodeBody | null>(null);
  /**
   * What the TMUX INSTALL answered, and nothing else.
   *
   * Its own slot rather than `runner.output`, which is the last of any action
   * and lives as long as this component does — so a failed `service` verb or
   * agent install, produced on the status screen, would render under "The tmux
   * install didn't finish." the next time anyone walked to the tmux screen.
   * `apps/server/desktop` keeps a `tmuxResult` for exactly that reason and says
   * so at the declaration; this is its twin, written only by
   * {@link NodeCommands.installTmux}.
   */
  const [tmuxResult, setTmuxResult] = useState<ActionResult | null>(null);

  const commands = useNodeCommands({
    runner,
    probe,
    form,
    onEnrolled: (node) => {
      setEnrolledNode(node);
      setOverride(null);
    },
    onTmuxInstall: setTmuxResult,
  });

  const screen = clientScreen({ probe, settings, step, override });

  /** Start (or retry) the register chain from the start-up screen's press. */
  const runRegister = () => {
    if (runner.busy) return;
    setPhase("form");
    setFailedAct(null);
    setStep("registering");
    commands.register({ startAtLogin, onPhase: setPhase, onFailed: setFailedAct });
  };

  /**
   * The action's own refusal answers what was clicked, so it outranks a probe
   * failure, which is background weather. That precedence is the fix for a
   * defect this page had to preserve through two rewrites: a re-probe must
   * never be able to replace the message an action just produced.
   */
  const problem = runner.failure || readError || probe?.error || "";

  const shell: FrameShell = {
    title: screen ? screenTitle(screen) : "Checking This Machine",
    subtitle: screen ? subtitleFor(screen, probe, settings) : undefined,
    problem,
    confirm: runner.pending ? (
      <ConfirmPanel
        pending={runner.pending}
        busy={runner.busy}
        onAccept={runner.accept}
        onCancel={() => {
          runner.cancel();
          // A consent the register chain REQUIRED and did not get. The act did
          // not fail on its own, so `register()` leaves the row active while
          // the panel is up — but a dismissed panel would otherwise leave a
          // checklist spinning on an act that has stopped, with nothing to
          // press. Marking it here is what puts Retry back on the screen, and
          // this is the only press that knows the difference.
          if (step === "registering") setFailedAct("enroll");
        }}
      />
    ) : undefined,
  };

  if (screen === null) {
    // Nothing read yet, or the probe itself could not be read. The second is
    // not a state to sit in silently: `problem` names it and Retry is the one
    // thing that can change it.
    const failed = !firstProbePending && probe === undefined;
    return (
      <Frame
        {...shell}
        subtitle={failed ? undefined : "Reading this machine's agent, service and configuration."}
        barRight={
          failed ? (
            <Button className="min-w-[120px]" disabled={runner.busy} onClick={commands.refresh}>
              Retry
            </Button>
          ) : undefined
        }
      />
    );
  }

  const facts = { probe, settings, enrolledNode, output: runner.output };

  switch (screen) {
    case "welcome":
      return <WelcomeScreen shell={shell} busy={runner.busy} onContinue={() => setStep("choice")} />;
    case "choice":
      return (
        <ChoiceScreen
          shell={shell}
          busy={runner.busy}
          onChoose={(choice) => {
            // Seed the enrol form's server field from the plane this app
            // already knows, so a watcher who decides to register does not
            // retype an address they have already given once.
            if (choice === "node") form.seedServer(settings?.planeUrl ?? "");
            setStep(choice);
          }}
        />
      );
    case "tmux":
      return (
        <TmuxScreen
          shell={shell}
          probe={probe}
          busy={runner.busy}
          onInstall={commands.installTmux}
          // The TMUX INSTALL's own words, never `runner.output` — that is the
          // last of any action and outlives the screen it was produced on, so
          // a failed service verb would render here as a tmux failure. The
          // server app keeps its own slot for exactly this reason.
          result={tmuxResult}
          // Which of `problem`'s three sources is the runner's — the only one
          // the failure card replaces. See the prop's own docblock.
          runnerFailure={runner.failure}
          // Same asymmetry as Register's: Choice for a fresh machine, the
          // status screen for a configured client that came here from
          // "Register this machine". This screen needs it most — a machine
          // without tmux can wait here forever.
          //
          // NOT gated on `runner.busy`, alone among this page's handlers, and
          // that is the whole point of the button: `tmux-screen.tsx` draws it
          // live while the install runs and says why at the point it draws it
          // — a screen whose complaint is "there is no way out of this wait"
          // cannot take its way out away for the length of it, and a `brew
          // install` is a minute or more. Gating here would leave a live
          // button whose press does nothing, which says less than a disabled
          // one does. Leaving is safe: the install is Rust's and finishes
          // either way, the next probe sees the tmux it produced, and every
          // control on the screen this lands on is disabled by `busy` as usual.
          onBack={() => setStep(configured(settings, probe) ? null : "choice")}
        />
      );
    case "register":
      return (
        <RegisterScreen
          shell={shell}
          probe={probe}
          form={form}
          busy={runner.busy}
          // The credentials are collected here and nothing is spent yet: the
          // start-up question is the last thing asked, because its answer
          // parameterizes the chain's own `service install`.
          //
          // Where Back goes, and why it is not always the same place: a fresh
          // machine came through Choice and returns there, while a client that
          // was ALREADY configured reached this screen from the status screen's
          // "Register this machine" — for that person Choice is a screen they
          // never saw, and `setStep(null)` puts them back on the landing with
          // their dashboard button. Without this the status-screen door was
          // one-way for the rest of the session.
          onBack={() => {
            if (runner.busy) return;
            setStep(configured(settings, probe) ? null : "choice");
          }}
          // Validated HERE as well as inside the chain, because this is the
          // screen that OWNS the fields. The button is gated only on them
          // being non-empty, so `https//typo` and a truncated key both reach
          // this press; `validateEnroll`'s per-field refusals are written to
          // the form, and if the page had already moved on nobody would ever
          // see them.
          onRegister={() => {
            if (runner.busy) return;
            if (form.validate() === null) return;
            setStep("startup");
          }}
        />
      );
    case "startup":
      return (
        <StartupScreen
          shell={shell}
          busy={runner.busy}
          startAtLogin={startAtLogin}
          onChange={setStartAtLogin}
          onContinue={runRegister}
          // Back to the details form. `"node"` rather than a register-specific
          // step because the walk re-enters through the tmux gate, which
          // answers instantly when tmux is there — so this lands on the fields
          // in the ordinary case and on Install tmux in the one case where the
          // machine has stopped being able to register at all.
          onBack={() => {
            if (runner.busy) return;
            setStep("node");
          }}
        />
      );
    case "progress":
      return (
        <ProgressScreen
          shell={shell}
          busy={runner.busy}
          rows={registerSteps(probe, phase, failedAct)}
          failureOutput={failedAct ? runner.output?.stderr || runner.output?.stdout || "" : ""}
          done={phase === "done"}
          // The walk ends HERE rather than when the last act returned: the
          // completed checklist is the answer to "what did that just do", and
          // a pane that navigates away the moment it becomes an answer is the
          // jarring thing the sibling app was reported for.
          onContinue={() => setStep(null)}
          onRetry={runRegister}
          // Back to the details, unless the machine is already registered —
          // only the service act fails after enrolment has landed, and by then
          // changing the details would mean enrolling a second time.
          onEdit={failedAct === null || failedAct === "start" ? undefined : () => setStep("node")}
        />
      );
    case "connect":
      return <ConnectScreen shell={shell} commands={commands} busy={runner.busy} />;
    case "status":
      return (
        <StatusScreen
          shell={shell}
          {...facts}
          commands={commands}
          busy={runner.busy}
          onRegister={() => {
            if (runner.busy) return;
            form.seedServer(probe?.status?.serverUrl ?? settings?.planeUrl ?? "");
            setStep("node");
          }}
          onReenroll={() => {
            if (runner.busy) return;
            form.seedServer(probe?.status?.serverUrl ?? settings?.planeUrl ?? "");
            setOverride("enroll");
          }}
          onReset={() => setOverride("reset")}
          onCheckAppUpdate={() => setOverride("app-update")}
        />
      );
    case "enroll":
      return (
        <EnrollScreen
          shell={shell}
          {...facts}
          form={form}
          commands={commands}
          busy={runner.busy}
          onCancel={
            override === "enroll"
              ? () => {
                  if (runner.busy) return;
                  form.clearErrors();
                  setOverride(null);
                }
              : undefined
          }
        />
      );
    case "about":
      return <AboutScreen shell={shell} probe={probe} onClose={() => setOverride(null)} />;
    case "app-update":
      return <AppUpdateScreen shell={shell} onClose={() => setOverride(null)} />;
    case "reset":
      return (
        <ResetScreen shell={shell} {...facts} runner={runner} busy={runner.busy} onCancel={() => setOverride(null)} />
      );
  }
}
