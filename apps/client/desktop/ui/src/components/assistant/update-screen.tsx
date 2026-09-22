/**
 * Update Subshell Client — the app AND the node CLI it ships, in one act.
 *
 * It replaces `app-update-screen.tsx` and, with it, the status screen's
 * standalone "Update the node to X": each desktop bundle carries the CLI it
 * wraps, so those were never two independent things (spec 2026-09-18 § 1).
 * Two controls whose names differed by a possessive also produced a loop that
 * reads as a bug — update the app, and the next launch's probe sees a bundled
 * node CLI newer than the installed one and asks again.
 *
 * **Two phases, across the relaunch the app install ends in.** Phase 1 states
 * what is behind, downloads and installs the app bundle, and Rust writes a
 * marker before `app.restart()`. Phase 2 is a DIFFERENT PROCESS: the new build
 * boots, `node_probe` weighs that marker against this machine, and this screen
 * finishes the act by installing the bundled node CLI. The phase-1 press is the
 * consent for both halves, which is why the resumed install raises no
 * confirmation — asking again after a relaunch, on a screen the person did not
 * choose to open, would be asking for something already granted.
 *
 * **It is the only screen here whose facts are partly from the network.**
 * Everything else this window shows is a probe of this machine on a five-second
 * cycle; the release list is a third party, and asking it on a cycle would be
 * the background update check the design explicitly does not have (spec
 * 2026-09-15 § 14). So the query is `staleTime: Infinity` with no refetch, and
 * Check Again is the only thing that asks twice.
 *
 * **What it presses is a SELECTION** (spec § 13): a table of every component,
 * a checkbox on every row that has something to do — ticked by default, so
 * both halves behind is still one press — and, where a row has nothing to do,
 * the reason in the cell where its checkbox would be. It exists because the
 * two halves can diverge: a `subshell` installed by hand outranks the one
 * inside this app, and the screen used to name that newer version as a target
 * it would be replaced by. There is no Force checkbox here, deliberately —
 * see the comment on the app press below.
 *
 * Every decision it draws is {@link updateAct}'s, in `lib/update-act.ts`, where
 * `bun test` can reach it without a webview. What lives here is the two
 * queries, the progress subscription, and the page state that says what THIS
 * window has already done.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { Download } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { Button } from "@/components/ui/button";
import type { ActionRunner } from "@/hooks/use-action-runner";
import type { NodeCommands } from "@/hooks/use-node-commands";
import { IS_MACOS } from "@/lib/copy";
import type { ActionResult } from "@/lib/ipc";
import { type AppUpdateCheck, nodeCheckAppUpdate, nodeInstallAppUpdate, type Probe } from "@/lib/ipc";
import { type UpdateRowId, type UpdateSelection, updateAct } from "@/lib/update-act";

export const APP_UPDATE_KEY = ["node-app-update"] as const;

/** Megabytes, one decimal — the unit a download is read in. */
const mb = (n: number): string => (n / 1_000_000).toFixed(1);

export function UpdateScreen(props: {
  shell: FrameShell;
  probe: Probe | undefined;
  /** The rail node the app computed for this screen, or undefined when the screen is full-window. */
  rail?: ReactElement;
  commands: NodeCommands;
  runner: ActionRunner;
  onClose: () => void;
}) {
  const { probe, commands, runner, onClose } = props;

  const { data, isFetching, refetch, error } = useQuery<AppUpdateCheck>({
    queryKey: APP_UPDATE_KEY,
    queryFn: nodeCheckAppUpdate,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    // One try. A release source that will not answer arrives as `reason` on a
    // resolved check; a rejection here is the plugin refusing, which retrying
    // cannot fix.
    retry: false,
    refetchOnWindowFocus: false,
  });

  /** The download's own last line, from Rust's progress events. */
  const [progress, setProgress] = useState("");
  useEffect(() => {
    const unlisten = listen<{ received: number; total: number | null }>("node-app-update-progress", (event) => {
      const { received, total } = event.payload;
      setProgress(
        total === null ? `Downloading… ${mb(received)} MB` : `Downloading… ${mb(received)} of ${mb(total)} MB`,
      );
    });
    return () => {
      // Both halves swallow: a subscription that never came up has nothing to
      // tear down, and a teardown racing the window going away must not become
      // an unhandled rejection.
      void unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  const installApp = useMutation({
    // Takes the node row's checkbox, which is the whole of what crosses the
    // relaunch (§ 13.1): false writes no marker, so phase 2 never runs.
    mutationFn: (installNode: boolean) => nodeInstallAppUpdate(installNode),
    onMutate: () => setProgress("Starting the download…"),
    // No `onSuccess`: this call does not resolve on success, because the app
    // restarts out from under this page.
    onError: () => setProgress(""),
  });

  /**
   * What THIS WINDOW has done to the node CLI, and whether the daemon has been
   * restarted since.
   *
   * Page state on purpose (spec § 7.1). `rename(2)` leaves a running process
   * on its original inode, so after a successful install the file says the new
   * version while the daemon is still the old one — and no probe here can see
   * that. "This window installed a node CLI and did not restart it" is a fact
   * about what just happened, exactly as `ranSetupHere` is on the server side,
   * and a restart from anywhere else or a later launch simply clears it.
   */
  const [installedNodeHere, setInstalledNodeHere] = useState(false);
  const [restartedHere, setRestartedHere] = useState(false);
  /**
   * Which of this screen's two runner actions is awaiting its verdict, and
   * what the runner was already saying when it was pressed.
   *
   * The second half is load-bearing and was a defect first: `runner.run`'s
   * `isPending` does NOT land in the same commit as this press, so an effect
   * guarded on `busy` alone runs once with the PREVIOUS action's output still
   * in place — and reads the node install's success as the restart's. So the
   * press records the output it saw, and a verdict is only read once the
   * runner has produced a different one.
   */
  const [awaiting, setAwaiting] = useState<{ act: "node" | "restart"; since: ActionResult | null } | null>(null);
  const watchFor = useCallback(
    (act: "node" | "restart") => setAwaiting({ act, since: runner.output }),
    [runner.output],
  );

  /**
   * Read that verdict once the runner has finished talking.
   *
   * `runner.pending` is part of the guard because a refused restart does not
   * END the act — it raises the CLI's verbatim refusal with `--force` behind
   * it, and that conversation is still this press. Only a settled run with
   * `ok` counts, so a refusal, a rejection or a cancelled confirmation leaves
   * the offer exactly where it was.
   */
  useEffect(() => {
    if (awaiting === null || runner.busy || runner.pending !== null) return;
    const answered = runner.output !== awaiting.since || runner.failure !== "";
    if (!answered) return;
    const succeeded = runner.output?.ok === true;
    if (succeeded && awaiting.act === "node") {
      setInstalledNodeHere(true);
      setRestartedHere(false);
    }
    if (succeeded && awaiting.act === "restart") setRestartedHere(true);
    setAwaiting(null);
  }, [awaiting, runner.busy, runner.pending, runner.output, runner.failure]);

  /**
   * Which halves the person has ticked (spec § 13).
   *
   * Sparse, and read through {@link updateAct}'s "absent means as this act
   * decided" — so nothing here has to be seeded from facts that arrive one
   * probe later, and a row cannot be ticked for a half that turns out to have
   * no act at all.
   */
  const [selection, setSelection] = useState<UpdateSelection>({});
  const toggle = useCallback(
    (id: UpdateRowId, on: boolean) => setSelection((current) => ({ ...current, [id]: on })),
    [],
  );

  const act = updateAct({
    check: data,
    probe,
    checking: isFetching,
    installingApp: installApp.isPending,
    installingNode: awaiting?.act === "node" && runner.busy,
    installedNodeHere,
    restartedHere,
    busy: runner.busy,
    selection,
  });

  /**
   * Phase 2 runs itself, ONCE per launch.
   *
   * The press that consented to it happened in another process, so there is
   * nothing left to ask; what there is instead is a bound, because an install
   * that fails every time would otherwise re-run on every render. The ref
   * bounds this launch and the marker's own `attempts` bounds the launches —
   * `halted` is Rust saying the second bound was reached, and the screen
   * then offers Retry rather than firing.
   *
   * Whether to fire at all is {@link updateAct}'s answer and not this
   * component's: a marker on a machine whose node CLI this app must not replace
   * is refused in words, and firing it here would perform the act the same
   * screen is refusing.
   */
  const resumed = useRef(false);
  const installNode = useRef(commands.installNode);
  installNode.current = commands.installNode;
  const resuming = act.autoFinish;
  useEffect(() => {
    if (resumed.current || !resuming || runner.busy) return;
    resumed.current = true;
    watchFor("node");
    installNode.current();
  }, [resuming, runner.busy, watchFor]);

  const problem =
    error instanceof Error ? error.message : installApp.error instanceof Error ? installApp.error.message : "";

  /** The primary press: the app half downloads, the node half is local. */
  const press = () => {
    if (!act.canPress) return;
    if (act.press === "app") {
      installApp.mutate(act.pressInstallsNodeCli);
      return;
    }
    watchFor("node");
    // A resumed or retried act was already consented to in phase 1; a direct
    // press on a node CLI that is merely behind has had no such moment, so it
    // goes through the command that asks first.
    if (act.resume) installNode.current();
    else commands.updateNode();
  };

  return (
    <Frame
      {...props.shell}
      rail={props.rail}
      problem={problem || props.shell.problem}
      icon={<Download />}
      // **The way out is this screen's PRIMARY, in the filled right seat**
      // (operator's call, 2026-09-18; the sibling app's update screen was
      // changed the same day for the same reason). The frame's contract is
      // "primary right and ghost left", and every screen that ASKS something
      // ends on a filled button there. This one's act is the press in the
      // CONTENT, so the bar has only the leave — and parking that in the
      // ghost-left seat left the filled seat empty and made the one footer
      // button the faintest thing in the frame.
      //
      // It stays **Back**, where the server app's says Close, and the
      // difference is real rather than a drift: that window is raised for a
      // screen and `host.close()` ends it, while this window is always open
      // and `onClose` drops the override for whatever the machine implies —
      // the status screen. Nothing closes here, so "Close" would be the word
      // lying about where it leads, which is the defect being fixed.
      barRight={
        <>
          {!installApp.isPending && (
            <Button
              className="min-w-[120px]"
              variant="outline"
              disabled={isFetching || runner.busy}
              onClick={() => void refetch()}
            >
              Check Again
            </Button>
          )}
          {/* The rail is the navigation now (operator ruling 2026-09-22): Back
              beside it answers a question the rail already answers — a select
              leaves, and the rail's Status is the way back. It stays ONLY where
              the rail is not: a mid-first-run machine raised here has none, and
              there Back is still the only way out. Check Again stays
              regardless: it is a refresh, not a leave. */}
          {props.rail === undefined && (
            <Button disabled={installApp.isPending} onClick={onClose}>
              Back
            </Button>
          )}
        </>
      }
    >
      {act.phase === "checking" && (
        <p className="text-center text-muted-foreground text-sm">Reading the project's release list.</p>
      )}

      {act.rows.length > 0 && (
        /*
         * One line per component (spec § 13.1): what it runs, what it would
         * become, and a checkbox where there is something to do. A row with no
         * available act carries its REASON in the cell where the checkbox
         * would be, never a disabled checkbox — a control that cannot be used
         * says "not now" without saying anything, and here the reason is the
         * content.
         *
         * A native `<input type="checkbox">` rather than one of the Base UI
         * primitives: those hide a native input with an inline style
         * attribute, which this bundle's `style-src 'self'` drops (see
         * `styles.css`'s Switch workaround). Nothing here needs a workaround
         * it does not have.
         */
        <table className="mx-auto w-full max-w-md text-sm">
          <thead>
            <tr className="text-detail text-muted-foreground">
              <th className="pb-2 text-left font-regular">Component</th>
              <th className="pb-2 text-left font-regular">Running</th>
              <th className="pb-2 text-left font-regular">New</th>
              <th className="pb-2 text-right font-regular">Update</th>
            </tr>
          </thead>
          <tbody>
            {act.rows.map((row) => (
              <tr key={row.id}>
                <td className="py-1 pr-4">{row.label}</td>
                <td className="py-1 pr-4 text-muted-foreground">{row.from}</td>
                <td className="py-1 pr-4">
                  {row.to.kind === "version" ? (
                    <span className="font-strong">{row.to.version}</span>
                  ) : row.to.kind === "with-app" ? (
                    // The number the app cannot know before it downloads: a
                    // desktop release manifest carries the component's version
                    // and its asset digests, never the version of the CLI
                    // inside the bundle (spec § 4.3). So this names the app
                    // that ships it, and the number appears after the
                    // relaunch.
                    <span className="font-strong">ships with the new app</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="py-1 text-right">
                  {row.selectable ? (
                    <input
                      type="checkbox"
                      className="size-4 accent-primary align-middle"
                      aria-label={`Update ${row.label}`}
                      checked={row.selected}
                      onChange={(event) => toggle(row.id, event.target.checked)}
                    />
                  ) : row.reason !== null ? (
                    <span className="text-detail text-muted-foreground">{row.reason}</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {act.upToDate && data && (
        <p className="text-center text-sm">
          Subshell Client {data.current} is the newest release, and its node CLI is installed.
        </p>
      )}

      {/*
       * The END of a successful act, which said nothing at all until
       * 2026-09-18: the rows are gone (nothing is behind any more) and
       * `upToDate` is false by design (something WAS behind, this window fixed
       * it), so the body rendered empty the moment the restart offer was taken
       * — and immediately, on a machine with no service to restart.
       */}
      {act.settled && (
        <p className="text-center text-sm">Subshell Client and the node CLI it ships are both up to date.</p>
      )}

      {act.refusals.length > 0 && (
        // A refusal is NOT an error banner. An air-gapped install and a
        // service that runs somebody else's binary are ordinary states of a
        // machine, and a red block over either teaches people to ignore red
        // blocks. Each one says what it did INSTEAD of what it refused.
        <div className="mt-4 space-y-2 text-center text-detail text-muted-foreground">
          {act.refusals.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}

      {act.phase === "finishing" && (
        <p className="mt-4 text-center text-sm">
          Finishing the update: installing the node CLI that ships inside this app.
        </p>
      )}

      {progress !== "" && <p className="mt-4 text-center text-detail text-muted-foreground">{progress}</p>}

      {/*
       * Linux installs through dpkg, which raises a system password sheet. A
       * sheet nobody was told about reads as malware — which is why this one
       * sentence branches on the platform: it is a genuine difference in what
       * the person has to DO, not in voice. It is all that is left of this
       * block, so the wrapper is gated too rather than leaving macOS an empty
       * spacer div.
       *
       * There is deliberately NO Force checkbox in this app (§ 13.3): Force
       * overrides the pane-safety refusal on a service RESTART, and phase 2
       * here restarts nothing — it OFFERS the restart (§ 7.1), which carries
       * its own override behind the CLI's own refusal. A control governing
       * nothing, rendered for symmetry with Subshell Server, would be a
       * promise of the same kind.
       */}
      {act.press === "app" && !IS_MACOS && (
        <p className="mt-4 text-center text-detail text-muted-foreground">
          Linux installs the package with dpkg, so your system will ask for your password.
        </p>
      )}

      {act.offerRestart && (
        <div className="mt-4 space-y-2 text-center text-sm">
          <p>The node CLI was replaced. The daemon is still running the previous version.</p>
          {act.restartCostsPanes && (
            // The pane-safety sentence belongs HERE and not on the install:
            // the swap is a `rename(2)` a running daemon never notices, so
            // nothing about installing a node CLI can close a subshell. The
            // RESTART can, and the CLI refuses it without `--force` for
            // exactly that reason.
            <p className="text-detail text-muted-foreground">
              The installed service definition does not spare live panes, so restarting closes every subshell running on
              this machine.
            </p>
          )}
          <div>
            <Button
              variant="outline"
              disabled={runner.busy}
              onClick={() => {
                if (runner.busy) return;
                watchFor("restart");
                // The existing command, never a second implementation of it:
                // it surfaces the CLI's verbatim refusal, offers `--force`
                // behind it, and points at Rewrite the service definition.
                commands.restart();
              }}
            >
              Restart the node
            </Button>
          </div>
        </div>
      )}

      {act.pressLabel !== null && (
        <div className="mt-4 text-center">
          <Button disabled={!act.canPress} onClick={press}>
            {installApp.isPending ? "Installing…" : act.pressLabel}
          </Button>
        </div>
      )}
    </Frame>
  );
}
