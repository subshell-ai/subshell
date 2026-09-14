import { useQuery } from "@tanstack/react-query";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { Button } from "@/components/ui/button";
import { type About, nodeAbout, nodeOpenWeb, type Probe, type WebTarget } from "@/lib/ipc";

export const ABOUT_KEY = ["node-about"] as const;

/**
 * One named link. The address is a means here, not the content: three URLs
 * side by side are unreadable.
 */
function AboutLink(props: { label: string; target: WebTarget }) {
  return (
    <button
      type="button"
      className="rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      onClick={() => {
        // A refused open is not worth a message on a screen whose whole job is
        // to state facts; the links are a convenience.
        void nodeOpenWeb(props.target).catch(() => {});
      }}
    >
      {props.label}
    </button>
  );
}

/**
 * What this app is, and under what terms.
 *
 * **It replaced a permanent one-line footer under every screen** (operator's
 * call, 2026-09-12). The assistant asks one question per screen, and a
 * colophon under that question reads as part of it — so this is something a
 * person ASKS for now, from the tray, rather than something that sits there.
 *
 * Every string comes from one `node_about` call, so the facts live only in
 * `crates/desktop-core/src/legal.rs`, which `scripts/license-fields.ts` holds
 * equal to the TypeScript copy and to the root LICENSE. A copy in this file
 * would be the one that detector cannot see.
 *
 * The CLI's version comes from the probe rather than from that call: it is a
 * different program's, and this pair — the desktop app's and the CLI's — is
 * what a person opens an About for, usually to put in a bug report. They are
 * LABELLED "Desktop app" and "CLI", matching Subshell Server's About and the
 * names the released artifacts carry, so the distinction is one a person
 * learns once rather than per app.
 */
export function AboutScreen(props: { shell: FrameShell; probe: Probe | undefined; onClose: () => void }) {
  const { data } = useQuery<About>({
    queryKey: ABOUT_KEY,
    queryFn: nodeAbout,
    // Constants compiled into the binary: they cannot change while the app
    // runs, so this is read once and never refetched, retried or re-attempted
    // on a remount.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    retryOnMount: false,
  });
  const agent = props.probe?.agent?.version;

  return (
    <Frame
      {...props.shell}
      barLeft={
        <Button variant="ghost" onClick={props.onClose}>
          Back
        </Button>
      }
    >
      {data ? (
        <div className="space-y-4 text-center text-sm">
          <div>
            {/* **"Desktop app" and "CLI"**, the same pair Subshell Server's
                About uses, so one reading teaches both. They are also the
                words the release artifacts already carry — the bundles versus
                `subshell-node-cli-<triple>` — which is the vocabulary a person
                meets first when they download either.
                The app is not named here because the frame's title already is
                ("About Subshell Client"); repeating it would spend the line
                that should say which of the two programs the number belongs
                to. */}
            <p>Desktop app {data.appVersion}</p>
            {agent && <p className="text-muted-foreground">CLI {agent}</p>}
          </div>
          <p className="text-muted-foreground text-xs">{data.licenseSummary}</p>
          <div className="flex flex-wrap items-center justify-center gap-x-3 text-muted-foreground text-xs">
            <AboutLink label="Website" target="website" />
            <span aria-hidden className="text-border">
              ·
            </span>
            <AboutLink label="Licence" target="license" />
            <span aria-hidden className="text-border">
              ·
            </span>
            <AboutLink label={data.company} target="company" />
          </div>
          <p className="text-muted-foreground text-xs">{data.copyright}</p>
        </div>
      ) : (
        <p className="text-center text-muted-foreground text-sm">Reading…</p>
      )}
    </Frame>
  );
}
