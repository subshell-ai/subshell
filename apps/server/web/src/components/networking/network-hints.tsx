import { CopyCommandRow } from "@/components/copy-command-row";
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
  return (
    <div className="space-y-1.5">
      <p className="text-detail text-muted-foreground">
        {/* Numbered only where the caller is rendering a SEQUENCE (the
            privileged setup steps). A lone hint is not step 1 of anything. */}
        {index !== undefined && <span className="mr-1.5 font-strong text-foreground">{index}.</span>}
        {hint.text}
      </p>
      {hint.command && <CopyCommandRow text={hint.command} />}
      {hint.docsUrl && (
        <a href={hint.docsUrl} target="_blank" rel="noreferrer" className="text-detail underline">
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
