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
 * A FOOTER rather than a section or a dialog, and both halves of that are the
 * page's own shape rather than a preference. This window is one flow — paste a
 * URL and a key, and this machine becomes a node — so there is nothing to
 * navigate between and a sidebar would be inventing a structure to hold one
 * page. And a modal is out on principle here: the bundle's CSP has no
 * `'unsafe-inline'` in `style-src`, so a portalled primitive that positions
 * itself with a `style` prop renders unstyled in the wrong place, which is why
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
  });
  if (!data) return null;

  // Both versions on one line. They are different programs, and "which
  // versions am I running" is what an About box is opened to answer — usually
  // to put in a bug report. The agent's comes from the probe the page already
  // holds, so it cannot disagree with what the status card is showing.
  const agent = props.probe?.agent?.version;
  const versions = agent ? `Version ${data.appVersion} · Agent ${agent}` : `Version ${data.appVersion}`;

  return (
    <footer className="mt-2 flex flex-col items-center gap-1 border-border/60 border-t pt-6 pb-1 text-center">
      <img
        src="./wordmark-192.png"
        srcSet="./wordmark-96.png 1x, ./wordmark-192.png 2x"
        alt="Subshell"
        className="h-9 w-auto"
      />
      <h2 className="mt-3 font-semibold text-[15px] tracking-tight">{data.appName}</h2>
      <p className="text-muted-foreground text-xs">{versions}</p>
      <p className="mt-2 max-w-md text-muted-foreground text-xs">
        Watch a Subshell control plane, and register this machine with it as a node.
      </p>
      <p className="mt-3 flex flex-wrap items-baseline justify-center gap-x-2 text-xs">
        <AboutLink label="Website" target="website" />
        <span aria-hidden className="text-border">
          ·
        </span>
        <AboutLink label="Licence" target="license" />
        <span aria-hidden className="text-border">
          ·
        </span>
        <AboutLink label={data.company} target="company" />
      </p>
      <p className="mt-4 text-[11px] text-muted-foreground">{data.licenseSummary}</p>
      <p className="text-[11px] text-muted-foreground">{data.copyright}</p>
    </footer>
  );
}
