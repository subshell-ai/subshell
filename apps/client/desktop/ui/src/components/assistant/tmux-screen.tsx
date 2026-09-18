/**
 * Install tmux — the hard gate in front of registering this machine
 * (spec 2026-09-18 § 5.2).
 *
 * **This pane is `apps/server/desktop`'s, mirrored** (`ui/src/wizard.ts`'s
 * `renderTmux`, `installProgress` and `manualRouteSteps`; the routes are
 * `ui/src/lib/installers.ts`'s). The operator asked for the two apps' tmux
 * install to be the same thing, and it is the same act on the same machine
 * through the same shared table (`desktop_core::tmux`), so a person who has
 * installed tmux from one of these apps should recognise the other. Copied
 * rather than imported, the way this app's tokens and `components/ui/`
 * primitives are — a diff between the two copies is the drift signal.
 *
 * What each half of it is for:
 *
 * - **There is no Continue, and no skip.** Every subshell runs in a tmux pane,
 *   so a node without one comes up online with an empty harness inventory and
 *   409s every launch — and `subshell enroll` refuses before its network call,
 *   which is what keeps a tmux-less box from spending a single-use setup key.
 *   The screen therefore has no way past it: it LEAVES BY ITSELF, when the
 *   poll next sees a tmux and the router stops routing here. A skip would only
 *   manufacture the failure nobody attributes to tmux. What the bar carries is
 *   **Back**, which is a different offer: it leaves the walk rather than
 *   passing the gate. The other app's tmux screen has no bar at all — it is one
 *   step of a first run with other ways home — while this one can be waited on
 *   forever, which is what {@link TmuxScreen}'s `onBack` is for.
 * - **While the install runs, the package manager's own last line shows**,
 *   under a spinner and a clock. The line is the only real progress there is —
 *   `brew` reports Fetching, then Pouring, then Summary, and no percentage can
 *   be derived from that — and the clock earns its place separately: a stalled
 *   download leaves the LINE unchanged, and without a second thing moving the
 *   screen looks frozen again. `node_install_tmux` streams those lines to this
 *   window alone.
 * - **Where the button could only refuse, it is not drawn at all.** A Mac with
 *   no Homebrew is that case: `node_install_tmux` has nothing it may run there
 *   and rejects with `NO_MANAGER`, and `TMUX_INSTALL_CMD` names `brew`, the
 *   program that is missing. `manualTmuxRoutes` answers with the two ways off
 *   that machine instead — and the same rule that keeps a skip off this screen
 *   keeps the button off it: an affordance whose only outcome is the failure
 *   teaches people to press through warnings.
 * - **A route's instructions are shown only when ASKED FOR.** Printing both
 *   shell lines up front asks someone to paste an unexplained command on a
 *   window's say-so; pressing a manager's name and being shown the one line
 *   for it does not (operator's call, 2026-09-14).
 *
 * One deliberate divergence from that source, so the two copies stay
 * comparable: the run path here ALSO prints the terminal command, under the
 * button, where the other app prints it only when it has no button to offer.
 * That is this screen's own rule from the day it shipped — a package manager
 * may want a password, and the one line a person can paste belongs on screen
 * before the press rather than after a refusal — and `app.test.tsx` pins it.
 *
 * The status line exists for the same reason the server's "Checking for tmux…"
 * does, and sits ABOVE the instructions for the same reason: this is the
 * screen a person walks away from to go and fix the machine, they read the top
 * of the pane when they come back, and a window that says nothing about
 * watching looks frozen.
 */
import { listen } from "@tauri-apps/api/event";
import { LoaderCircle, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { type ManualTmuxRoute, manualTmuxRoutes, TMUX_INSTALL_CMD } from "@/lib/copy";
import * as ipc from "@/lib/ipc";
import { INSTALL_LINE_EVENT, type Probe } from "@/lib/ipc";

/**
 * `m:ss` since the install began.
 *
 * Pure and taking `now`, so the format is testable without a clock — the
 * split this app keeps for everything with a contract rather than a rendering.
 */
export function elapsed(sinceMs: number, now: number): string {
  const total = Math.max(0, Math.round((now - sinceMs) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function TmuxScreen(props: {
  shell: FrameShell;
  probe: Probe | undefined;
  /** Runs the platform's tmux install; the host owns the command and its output. */
  onInstall: () => void;
  /**
   * Leave the walk — NOT a way past the gate.
   *
   * This is the screen a person can be parked on indefinitely: tmux is a hard
   * requirement for registration, and if it never appears nothing here
   * advances. Without this the only exits were installing tmux or quitting the
   * app, which made the Choice screen's "whichever you pick, the other is
   * still available afterwards" false in the one place it mattered most.
   *
   * It answers "I don't want to set this machine up as a node right now",
   * which is a different sentence from "let me register without tmux" — so it
   * is a Back, never a Skip, and the tests pin that no button here matches
   * /install tmux|continue|skip|later|not now/.
   */
  onBack?: () => void;
  busy: boolean;
}) {
  const { shell, probe, onInstall, onBack, busy } = props;
  // Empty means "this app can install tmux here", which is every machine but a
  // brew-less Mac. `true` while the probe has not answered: a screen that
  // dropped its button for the half-second before the first read would flicker
  // into the shape reserved for the one machine that cannot be helped.
  const routes = manualTmuxRoutes(probe?.hasBrew ?? true);
  /** The package manager's own last line, as `node_install_tmux` streams it. */
  const [line, setLine] = useState("");
  /** When this window started the install, for the clock. */
  const [startedAt, setStartedAt] = useState(0);
  /** Re-render once a second while the install runs; the clock reads the real time. */
  const [, setTick] = useState(0);
  /** Which manager's instructions are open, or none. */
  const [opened, setOpened] = useState<ManualTmuxRoute["target"] | null>(null);
  /** The site button's own refusal, in Rust's words. */
  const [problem, setProblem] = useState("");
  const alive = useRef(true);

  useEffect(() => {
    const unlisten = listen<string>(INSTALL_LINE_EVENT, (event) => {
      // Empty frames are the manager drawing progress with blank lines; they
      // would blank the one thing on screen that is moving.
      if (event.payload.trim() !== "") setLine(event.payload);
    });
    return () => {
      // Both halves swallow: a subscription that never came up has nothing to
      // tear down, and a teardown racing the window going away must not become
      // an unhandled rejection.
      void unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!busy) return;
    // A pane that arrives already busy has no stamp of its own — this screen
    // can be swapped away and back while `brew` runs — so it starts counting
    // from now rather than from the epoch. A press stamps earlier and more
    // accurately, and is left alone.
    setStartedAt((at) => (at === 0 ? Date.now() : at));
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [busy]);

  function start(): void {
    // Stamped and cleared HERE rather than in an effect on `busy`: the press is
    // the moment the install begins, and a line from the last run left on
    // screen under a fresh spinner would be a previous install's progress.
    setLine("");
    setStartedAt(Date.now());
    setTick(Date.now());
    onInstall();
  }

  function openSite(route: ManualTmuxRoute): void {
    // A MEMBER of the app's closed URL set, never an address: Rust owns every
    // page this app can open (`WebTarget`).
    ipc
      .nodeOpenWeb(route.target)
      .then(() => setProblem(""))
      .catch((error: unknown) => {
        if (alive.current) setProblem(String(error));
      });
  }

  // Named rather than inlined into the JSX: the three cases are one sentence
  // each and the screen's whole liveness is which one is showing.
  const status = busy
    ? "Installing tmux…"
    : probe && !probe.tmux
      ? "tmux was not found on the login PATH. This screen continues on its own as soon as it is there."
      : "Checking for tmux…";

  return (
    <Frame
      {...shell}
      icon={<SquareTerminal />}
      problem={problem === "" ? shell.problem : problem}
      barLeft={
        // Live during the install, where every other bottom-bar control in this
        // app is disabled by `busy`. Leaving changes nothing — the install runs
        // in Rust and finishes either way, and the next probe sees the tmux it
        // produced — and a screen whose whole complaint is "there is no way out
        // of this wait" cannot take its way out away for the length of it.
        onBack ? (
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
        ) : undefined
      }
    >
      <p className="text-muted-foreground text-sm leading-relaxed">
        Every subshell runs in a tmux pane, so this machine needs tmux before it can run one.
      </p>
      {busy ? (
        <InstallProgress startedAt={startedAt} line={line} />
      ) : (
        <p role="status" className="mt-4 text-detail text-muted-foreground">
          {status}
        </p>
      )}
      {routes.length === 0 ? (
        <div className="mt-6">
          {!busy && (
            <>
              <Button className="w-full" onClick={start}>
                Install tmux
              </Button>
              {/*
               * Centred under a full-width button: left-aligned, it reads as a
               * caption for the screen's left edge rather than for the button
               * it belongs to.
               */}
              <p className="mt-3 text-center text-detail text-muted-foreground">
                Your package manager may ask for your password.
              </p>
            </>
          )}
          {/*
           * KEPT where the server app shows no command on this branch: the one
           * line a person can paste is not a fallback for a failure here, it
           * is on screen before the press — this app's own rule since the
           * screen shipped, and `app.test.tsx` pins it.
           */}
          <div className="mt-6">
            <p className="text-detail text-muted-foreground">Or run this in a terminal:</p>
            <div className="mt-2 flex items-start gap-1">
              <p className="min-w-0 break-all font-mono text-detail">{TMUX_INSTALL_CMD}</p>
              <CopyButton value={TMUX_INSTALL_CMD} label="the install command" />
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-6">
          {/*
           * What to DO, not what this machine lacks. The server app's screen
           * read "This machine has no package manager this app can drive",
           * which explains this app's position to someone who only wants tmux
           * (operator's call, 2026-09-14).
           */}
          <p className="text-center text-body text-muted-foreground leading-relaxed">
            Installing tmux through Homebrew or MacPorts is recommended.
          </p>
          {/*
           * Two ordinary buttons side by side, Homebrew first — it is what
           * almost everyone means. Pressing one REVEALS that manager's
           * instructions below; nothing is shown until asked for.
           */}
          <div className="mt-4 flex justify-center gap-2">
            {routes.map((route) => (
              <Button
                key={route.target}
                variant="outline"
                aria-pressed={opened === route.target}
                onClick={() => setOpened(opened === route.target ? null : route.target)}
              >
                {route.name}
              </Button>
            ))}
          </div>
          {routes
            .filter((route) => route.target === opened)
            .map((route) => (
              <ManualRouteSteps key={route.target} route={route} onOpenSite={() => openSite(route)} />
            ))}
        </div>
      )}
    </Frame>
  );
}

/**
 * What the install shows while it runs: a spinner, a clock, and the package
 * manager's own last line.
 *
 * `aria-live="polite"` on the line, so a screen reader hears the manager's own
 * words as they change rather than nothing at all for ten minutes.
 */
function InstallProgress(props: { startedAt: number; line: string }) {
  const { startedAt, line } = props;
  const now = Date.now();
  // The stamp lands in an effect, so the FIRST frame of a pane that mounted
  // already busy still has none. Counting from the epoch there would print a
  // five-figure clock for one frame, which is the sort of thing a person
  // screenshots.
  const since = startedAt === 0 ? now : startedAt;
  return (
    <div className="mt-4 rounded-lg border border-border bg-background px-4 py-3">
      <p role="status" className="flex items-center gap-2">
        <LoaderCircle aria-hidden className="size-4 text-primary motion-safe:animate-spin" />
        <span className="font-strong text-label">Installing tmux…</span>
        <span className="text-detail text-muted-foreground">{elapsed(since, now)}</span>
      </p>
      <p aria-live="polite" className="mt-2 break-all font-mono text-detail text-muted-foreground">
        {line || "Starting the package manager…"}
      </p>
    </div>
  );
}

/**
 * One manager's instructions, shown after its button is pressed.
 *
 * Two steps, in the order they happen: get the manager from its own site, then
 * run one line. Only the second is PRINTED — the line that installs a package
 * MANAGER is a `curl … | bash` nobody should take from a window's say-so, and
 * each project carries it on its own page in its own words.
 *
 * No numbering: two things in the order they are laid out, where the words
 * carry the order. But each line has to SAY where it leads — "Don't have
 * Homebrew?" over a button that opens a website answers a question with a dead
 * end, leaving "open the site and then what?" (operator's report, 2026-09-14).
 * So the first line says what the site is for and that you come back, and the
 * second says what you can do once you have it.
 */
function ManualRouteSteps(props: { route: ManualTmuxRoute; onOpenSite: () => void }) {
  const { route, onOpenSite } = props;
  return (
    <div className="mt-4 rounded-lg border border-border px-4 py-4">
      <p className="text-detail text-muted-foreground">
        Don't have {route.name}? Install it from its site, then come back.
      </p>
      <Button variant="outline" className="mt-2" onClick={onOpenSite}>
        Open {route.name} site
      </Button>
      <p className="mt-4 text-detail text-muted-foreground">Once you have {route.name}, run:</p>
      <div className="mt-2 flex items-start gap-1">
        <p className="min-w-0 break-all font-mono text-detail">{route.command}</p>
        <CopyButton value={route.command} label={`the ${route.name} command`} />
      </div>
    </div>
  );
}
