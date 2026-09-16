import { Info } from "lucide-react";
import { CopyCommandRow } from "@/components/copy-command-row";
import { safeHref } from "@/lib/safe-href";
import type { NetworkHint } from "@/types/network";

/**
 * A plugin's own next step, rendered VERBATIM.
 *
 * The SPA writes none of this copy and must not paraphrase it: what a daemon
 * being down means, and what to type about it, is knowledge the plugin has and
 * this page does not — and every network will word it differently. The page's
 * job is the shape: the sentence, the command under it where there is one, and
 * the vendor's page where there is one.
 *
 * A `privileged` hint carries no button anywhere in this surface. The server
 * has no terminal to answer a password prompt, so a control that ran it would
 * be a control that always fails; the command is copyable and nothing more.
 */
export function NetworkHintBlock({ hint, index }: { hint: NetworkHint; index?: number }) {
  // A hint's URL is the least trustworthy string on this page: a plugin often
  // reads it off a vendor CLI, which reads it off a control server. The server
  // drops a scheme a browser must not navigate to; this is the sink saying so
  // as well, so no upstream omission reaches an `href`.
  const docsUrl = safeHref(hint.docsUrl);
  return (
    <div className="space-y-1.5">
      <p className="text-detail text-muted-foreground">
        {/* Numbered only where the caller is rendering a SEQUENCE (the
            privileged setup steps). A lone hint is not step 1 of anything. */}
        {index !== undefined && <span className="mr-1.5 font-strong text-foreground">{index}.</span>}
        {hint.text}
      </p>
      {hint.command && <CopyCommandRow text={hint.command} />}
      {docsUrl && (
        <a href={docsUrl} target="_blank" rel="noreferrer" className="text-detail underline">
          Docs ↗
        </a>
      )}
    </div>
  );
}

/**
 * Every hint a status carries, in the order the plugin put them in.
 *
 * `startAt` runs a step count through them, and only the hints carrying a
 * COMMAND take a number. That distinction is the whole rule: a plugin's list
 * opens with a sentence saying what is wrong ("Meshtool is not installed on
 * this machine.") and then the commands that fix it. Numbering the sentence
 * tells the reader to perform it and pushes every real step one along.
 *
 * Whether to number at all is the CALLER's, because only it can see the rest
 * of the sequence — the privileged steps above these hints are part of the
 * same count.
 *
 * @param startAt - the number to give the first hint that carries a
 *   command; unset renders no numbers at all
 */
export function NetworkHints({ hints, startAt }: { hints: NetworkHint[]; startAt?: number }) {
  if (hints.length === 0) return null;
  // Assigned in one pass rather than inside the render, so the counter
  // advances over the hints that take a number and skips the ones that do not
  // — a `map` that incremented as it rendered would be a side effect in a
  // render function, and React is free to call one twice.
  let next = startAt;
  const numbered = hints.map((hint) => {
    if (next === undefined || hint.command === undefined) return { hint, index: undefined };
    const index = next;
    next += 1;
    return { hint, index };
  });
  return (
    <div className="space-y-3">
      {numbered.map(({ hint, index }) => (
        <NetworkHintBlock key={`${hint.text}${hint.command ?? ""}`} hint={hint} index={index} />
      ))}
    </div>
  );
}

/**
 * Split a hint list into the sentences that OPEN it and everything after.
 *
 * The lead is every hint before the first one carrying a COMMAND. That is the
 * plugin's own convention — a list opens by saying what is wrong and then
 * gives the commands that fix it — and it is what lets a caller render the
 * explanation above a sequence that came from somewhere else.
 *
 * The cut is at the first command rather than at "every hint without one",
 * because a sentence AFTER a plugin's commands is a different thing: it says
 * what to do once they are done, and hoisting it would state the last
 * instruction first. A list with no commands at all is therefore all lead —
 * on a `not-installed` row the fix is the manifest's steps, so prose beside
 * them is the explanation of the state, never a footnote to it.
 */
export function splitLeadHints(hints: NetworkHint[]): { lead: NetworkHint[]; rest: NetworkHint[] } {
  const firstCommand = hints.findIndex((hint) => hint.command !== undefined);
  if (firstCommand === -1) return { lead: hints, rest: [] };
  return { lead: hints.slice(0, firstCommand), rest: hints.slice(firstCommand) };
}

/**
 * The state's own explanation, as a notice above whatever fixes it.
 *
 * Distinct from {@link NetworkHintBlock} in weight, not just position: this
 * sentence used to render in the same muted grey as a step label, below the
 * steps it explains, so a card for a machine with nothing installed opened
 * with "1. Install the Tailscale daemon" and said WHY somewhere in the middle.
 * A person scanning the card never saw it.
 *
 * Neutral rather than the amber used for exposure: not having installed
 * something yet is the ordinary state of a fresh machine, and spending the
 * warning colour here would leave nothing louder for the row that puts a
 * server on the public internet.
 */
export function NetworkNotice({ hints }: { hints: NetworkHint[] }) {
  if (hints.length === 0) return null;
  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2">
      <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="space-y-1.5">
        {hints.map((hint) => {
          const docsUrl = safeHref(hint.docsUrl);
          return (
            <p key={hint.text} className="text-detail">
              {hint.text}{" "}
              {docsUrl && (
                <a href={docsUrl} target="_blank" rel="noreferrer" className="underline">
                  Docs ↗
                </a>
              )}
            </p>
          );
        })}
      </div>
    </div>
  );
}
