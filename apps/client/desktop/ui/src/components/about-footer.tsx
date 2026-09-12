/**
 * What this app is, who made it, and under what terms.
 *
 * The same content and the same shape as Subshell Server's console About
 * section — mark, app name, versions, a row of links, the licence, the
 * copyright, centred — because the two apps must not disagree about who owns
 * the product or what the terms are. Every string comes from one `node_about`
 * call, so the facts live only in `crates/desktop-core/src/legal.rs`, which
 * `scripts/license-fields.ts` holds equal to the TypeScript copy and to the
 * root LICENSE. A copy in this file would be the one that detector cannot see.
 *
 * ONE LINE, under the assistant's bottom bar (spec 2026-09-12 § 6.4). The card
 * page had room for a full colophon — mark, heading, blurb, licence, copyright
 * — and the assistant does not: every screen is one question, and a block of
 * ownership prose under it competes with the answer. What a person opens an
 * About for is the version pair, to put in a bug report, so that is what stays
 * on the face; the terms and the owner stay one click away as named links.
 *
 * A modal is out on principle here: the bundle's CSP has no `'unsafe-inline'`
 * in `style-src`, so a portalled primitive that positions itself with a
 * `style` prop renders unstyled in the wrong place, which is why
 * `confirm-panel.tsx` is in the page too.
 *
 * macOS already has this in the app menu (`menu.rs` builds an `AboutMetadata`
 * from the same constants). Linux has no menu bar to put it in, and a person
 * looking for a version number should not have to know which platform
 * convention applies.
 */
import { useQuery } from "@tanstack/react-query";
import { type About, nodeAbout, nodeOpenWeb, type Probe, type WebTarget } from "@/lib/ipc";

export const ABOUT_KEY = ["node-about"] as const;

/** One named link. The address is a means here, not the content: three URLs side by side are unreadable. */
function AboutLink(props: { label: string; target: WebTarget }) {
  return (
    <button
      type="button"
      className="rounded-sm underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      onClick={() => {
        // A refused open is not worth a message on this surface — the links
        // are a convenience, and the page has one problem line, which belongs
        // to the action the user came here to run.
        void nodeOpenWeb(props.target).catch(() => {});
      }}
    >
      {props.label}
    </button>
  );
}

export function AboutFooter(props: { probe: Probe | undefined }) {
  const { data } = useQuery<About>({
    queryKey: ABOUT_KEY,
    queryFn: nodeAbout,
    // Constants compiled into the binary: they cannot change while the app
    // runs, so this is read once and never refetched or polled.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    // …and not re-attempted on a remount either. The assistant swaps whole
    // screens, so this footer unmounts and mounts again whenever the machine's
    // state moves it — and a query left in an error state is retried on mount
    // by default. There is nothing to retry FOR: these are strings compiled
    // into the binary, so a read that failed once fails the same way.
    retryOnMount: false,
  });
  if (!data) return null;

  // Both versions on one line. They are different programs, and "which
  // versions am I running" is what an About box is opened to answer — usually
  // to put in a bug report. The agent's comes from the probe the page already
  // holds, so it cannot disagree with what the status card is showing.
  const agent = props.probe?.agent?.version;
  const versions = agent ? `${data.appVersion} · Agent ${agent}` : data.appVersion;

  return (
    <footer className="flex flex-wrap items-baseline justify-center gap-x-2 text-[11px] text-muted-foreground">
      <span>
        {data.appName} {versions}
      </span>
      <span aria-hidden className="text-border">
        ·
      </span>
      <AboutLink label="Website" target="website" />
      <span aria-hidden className="text-border">
        ·
      </span>
      <AboutLink label="Licence" target="license" />
      <span aria-hidden className="text-border">
        ·
      </span>
      <AboutLink label={data.company} target="company" />
    </footer>
  );
}
