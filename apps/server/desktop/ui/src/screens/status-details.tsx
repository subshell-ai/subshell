/**
 * The Status section's own details (spec 2026-09-21; plan Task 4, made
 * inline by the operator's 2026-09-22 wave-2 ruling) — the port of
 * `detailsDisclosure` and `refreshTail`'s render half.
 *
 * The pre-boot facts, the server's log and the last action's own words.
 * All three were separate surfaces in the console — a Details list, a Logs
 * section, an output pane — reachable only by navigating away from the thing
 * that was wrong; they became one block under the diagnosis, and wave 2 made
 * that block the Status SECTION'S content: no disclosure to open, because a
 * sidebar section that hides its own facts behind a second control is two
 * navigations for one answer. The tail is fed while the section is up
 * (`host.tsx`'s `statusUp` rule), which is the open-disclosure rule carried
 * over under a new name.
 */
import type { ReactElement } from "react";
import { Fragment, useEffect, useRef } from "react";
import type { About, ActionResult, LogTail, OpenTarget, Probe } from "../lib/ipc";
import { recoveryFacts } from "../lib/recovery-model";

/**
 * The server's log tail, keeping the view where the reader put it.
 *
 * Re-tailing while someone has scrolled up to read would yank the view out
 * from under them, and this runs on the page's poll while the disclosure is
 * open — so the check is not a nicety. The old code measured "at bottom"
 * BEFORE writing the new text; a React render writes first, so the same fact
 * is carried by a scroll listener instead: wherever the reader last left the
 * pane is what the next tail honours.
 */
function TailPane(props: { tail: LogTail | null }): ReactElement {
  const ref = useRef<HTMLPreElement | null>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    // No deps array: the stick is load-bearing on every tick while the
    // disclosure is open (the old renderTail re-measured and re-stuck each
    // poll), so this effect fires on every render — re-applying the same
    // scrollTop is a no-op, and missing a tick is a pane that stops
    // following the log.
    const box = ref.current;
    if (box === null) return;
    if (atBottom.current) box.scrollTop = box.scrollHeight;
  });
  return (
    <pre
      ref={ref}
      className={props.tail?.text ? "pane-pre" : "pane-pre muted-text"}
      onScroll={(e) => {
        const box = e.currentTarget;
        atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
      }}
    >
      {props.tail === null ? "" : props.tail.text || props.tail.note || ""}
    </pre>
  );
}

/** A result's own words, or nothing. `ok: false` is styled as a failure, not as output. */
function OutputPane(props: { result: ActionResult | null }): ReactElement | null {
  const result = props.result;
  const parts: string[] = [];
  if (result?.stdout?.trim()) parts.push(result.stdout.trim());
  if (result?.stderr?.trim()) parts.push(result.stderr.trim());
  // Appended only when the last press actually said something: `.pane-pre:empty`
  // collapses the box, so a heading over nothing is the one shape to avoid.
  if (parts.length === 0) return null;
  return (
    <>
      <p className="group-heading">Last action</p>
      <pre className={result?.ok === false ? "pane-pre output-bad" : "pane-pre"}>{parts.join("\n\n")}</pre>
    </>
  );
}

export function StatusDetails(props: {
  probe: Probe | null;
  lastResult: ActionResult | null;
  lastTail: LogTail | null;
  about: About | null;
  onReveal: (target: OpenTarget) => void;
}): ReactElement {
  return (
    <>
      {/* `.facts` is `display:grid; grid-template-columns:132px 1fr` and reads
          its dt/dd as DIRECT children (the old code appended dt, dd); a keyed
          wrapper div would make each row one grid item and collapse the
          table into alternating narrow columns. The key rides a Fragment. */}
      <dl className="facts">
        {/* Versions FIRST, beside the config they describe — this is the top of
            the section, not a footnote under the log. `This app` is the desktop
            bundle's version (shown even when the server is down); `Server CLI`
            is the version the running server binary reported. */}
        {props.about !== null && (
          <Fragment key="app-version">
            <dt>This app</dt>
            <dd>{`${props.about.appName} ${props.about.appVersion}`}</dd>
          </Fragment>
        )}
        {props.probe?.server?.version && (
          <Fragment key="cli-version">
            <dt>Server CLI</dt>
            <dd>{props.probe.server.version}</dd>
          </Fragment>
        )}
        {recoveryFacts(props.probe).map((f) => (
          <Fragment key={f.label}>
            <dt>{f.label}</dt>
            <dd>
              <span className={f.tone === "bad" ? "bad-text" : f.tone === "warn" ? "warn-text" : undefined}>
                {f.value}
              </span>
              {f.reveal && (
                /* Names an INTENT, never a path: the Rust side re-reads the path from
                   its own fresh probe, so a row can only reveal the fact it is showing. */
                <button
                  type="button"
                  className="rounded-sm text-body text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => props.onReveal(f.reveal as OpenTarget)}
                >
                  Reveal
                </button>
              )}
              {f.sub && <span className="fact-sub">{f.sub}</span>}
            </dd>
          </Fragment>
        ))}
      </dl>
      <p className="group-heading">Server log</p>
      <TailPane tail={props.lastTail} />
      <OutputPane result={props.lastResult} />
      {/* The version facts used to end the section here, beside the log. They
          moved to the TOP of the facts grid above (with the Server CLI version
          added), because they describe the install, not the transcript. The full
          About panel — terms, copyright, links — is the OS-standard one under the
          app menu (spec 2026-09-17 D6); only these two version strings belong on
          the screen. Do not re-add a line here. */}
    </>
  );
}
