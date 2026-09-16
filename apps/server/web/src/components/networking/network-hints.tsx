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
 * `startAt` numbers them, and only the caller knows whether that is honest:
 * on a machine with nothing installed the hints ARE the setup sequence — for
 * Tailscale they are the whole of it, since every install path there needs
 * root and a manifest may not ship a `sudo` command — so running the numbers
 * on from the privileged steps above is what makes them read as steps. In
 * every other state a hint is a standing fact about the machine, and a lone
 * "1." in front of one would promise a second that never comes.
 *
 * @param startAt - the number to give the first hint; unset renders none
 */
export function NetworkHints({ hints, startAt }: { hints: NetworkHint[]; startAt?: number }) {
  if (hints.length === 0) return null;
  return (
    <div className="space-y-3">
      {hints.map((hint, offset) => (
        <NetworkHintBlock
          key={`${hint.text}${hint.command ?? ""}`}
          hint={hint}
          index={startAt === undefined ? undefined : startAt + offset}
        />
      ))}
    </div>
  );
}
