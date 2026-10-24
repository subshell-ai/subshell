import { Button, cn, errMessage } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import { OpenPanel } from "@/components/preview/open-panel";
import { nodeReasonLine, PortList } from "@/components/preview/port-list";
import { ScreenViewer } from "@/components/preview/screen-viewer";
import { WatchViewer } from "@/components/preview/watch-viewer";
import { TrustNoticeBanner } from "@/components/trust-notice-banner";
import { useIsPhoneLayout } from "@/hooks/use-is-phone-layout";
import type { UseSubshellPreview } from "@/hooks/use-subshell-preview";
import type { TrustNotice } from "@/lib/trust-notices";
import type { SubshellAccess, SubshellView } from "@/types/subshell";

/**
 * The Preview section under a pane's terminal (spec §7): what the pane
 * currently offers to watch, and the three named verbs - Open, Watch, Screen.
 *
 * It is presentational by choice: the pane route owns `useSubshellPreview`
 * and hands the controller down, which keeps every protocol half (the REST/
 * socket dance, the throttle) in the hook where it can be tested without
 * DOM. This file only decides what the truth looks like: which row carries
 * which control, what a gate says, and what never renders on a phone (the
 * dock's own tiling-for-tabs trade: the panel is desktop furniture, Watch
 * paints frames fine on any layout).
 *
 * The disclosure variant is reuse, not a new subsystem: a shared pane's
 * banner fires once per device HERE TOO (its own dismiss key), because this
 * surface shows more than the terminal does - a live screen, not a log.
 */

export type PreviewChoice = { kind: "app"; port: number } | { kind: "screen" } | { kind: "browser" };

export interface PreviewSectionProps {
  initialView?: PreviewChoice | null;
  onViewChange?: (choice: PreviewChoice | null) => void;
  /** The pane being previewed; watch frames key on it. */
  paneId: string;
  /** The caller's resolved access, exactly as the terminal reads it. */
  access: SubshellAccess;
  /** The row, for the shared-exposure disclosure. */
  subshell?: SubshellView;
  /** The hook's controller. */
  preview: UseSubshellPreview;
  /**
   * The dock's phone predicate, overridable for the tests: on a phone the
   * Open panel never renders; a prepared preview opens through a new-tab link.
   */
  isPhone?: boolean;
  /** Test seam for the banner's dwell, passed straight through. */
  bannerVisibleMs?: number;
  onHide?: () => void;
  fill?: boolean;
}

/**
 * The shared-pane disclosure, in the PREVIEW surface's own copy and under its
 * own seen-mark key. The terminal's banner (same exposure, `shared:` prefix)
 * may already be dismissed on this device; "I know it's shared" does not yet
 * mean "I know previews show more", and the spec raises it exactly once more.
 */
export function previewSharedNotice(subshell: SubshellView | undefined): TrustNotice | null {
  const count = subshell?.shareCount ?? 0;
  if (!subshell || count <= 0) return null;
  const everyone = subshell.sharedWithEveryone ?? false;
  const who = everyone
    ? "everyone signed in to this instance"
    : count === 1
      ? "1 other person"
      : `${count} other people`;
  const owned = subshell.access === "owner";
  return {
    kind: "preview",
    // The count is in the key, like the terminal's notice: a wider audience
    // is new information, not a dismissed one.
    dismissKey: `preview:shared:${subshell.id}:${count}:${everyone}`,
    banner: owned
      ? `You've shared this subshell with ${who}. A preview here is a live view of the pane, not just its log, so what you open or watch shows them the same thing.`
      : `This subshell belongs to someone else and is shared with ${who}. Previews show a live view of the pane, visible the same way from the outside.`,
    tooltip: `Shared with ${who}. Previews show a live view, not just the log.`,
    label: owned ? `Shared with ${who}` : "Someone else's subshell",
  };
}

export function PreviewSection({
  paneId,
  access,
  subshell,
  preview,
  isPhone,
  bannerVisibleMs,
  onHide,
  fill = false,
  initialView,
  onViewChange,
}: PreviewSectionProps): JSX.Element {
  const phoneDefault = useIsPhoneLayout();
  const phone = isPhone ?? phoneDefault;
  const [open, setOpen] = useState<{ port: number; proxyBase: string } | null>(null);
  // The open screen session: the display is kept from the answer so a later
  // info poll that reports the display gone cannot retitle the live viewer.
  const [screenSession, setScreenSession] = useState<{ display: string; proxyBase: string } | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === sectionRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === sectionRef.current) await document.exitFullscreen();
      else await sectionRef.current?.requestFullscreen();
    } catch {
      setOpenError("Couldn't enter full screen. Try opening the app in a new tab for more room.");
    }
  }
  const [openError, setOpenError] = useState<string | null>(null);
  const info = preview.info;
  const notice = useMemo(() => previewSharedNotice(subshell), [subshell]);

  // Repointing this page at another pane must drop everything that belongs
  // to the pane the user was looking at: the route holds no key on this
  // Section, so swipe navigation changes `paneId` on the SAME instance (the
  // route's own `[id]` effects exist for exactly that). Carrying pane A's
  // screen session into B would render A's live VNC under B's name, and RFB's
  // pump keeps pv-ws from ever idling the lane (idle expiry needs a silent
  // side), so A's forward slot would stay pinned indefinitely. The Open panel
  // and its error are the same pane-scoped state.
  // The clear-what-is-up half of pane navigation. The other half is in the
  // open handlers: an in-flight POST that answers after the repoint must not
  // repopulate the new pane with the old one's lane, so every handler
  // captures this counter and ignores its answer once the counter moved.
  const generation = useRef(0);
  const resumed = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the paneId dependency IS the reset, the React prop-change pattern. The body never reads paneId (its setters are stable), which is what the exhaustive-deps autofix would strip and what shipped the bug this pins.
  useEffect(() => {
    generation.current += 1;
    setScreenSession(null);
    setOpen(null);
    setOpenError(null);
  }, [paneId]);

  async function handleOpen(port: number): Promise<void> {
    resumed.current = true;
    const gen = generation.current;
    setOpenError(null);
    try {
      const { proxyBase } = await preview.openPort(port);
      if (generation.current !== gen) return;
      setScreenSession(null);
      if (preview.watching) await preview.stopWatch();
      if (generation.current !== gen) return;
      setOpen({ port, proxyBase });
      onViewChange?.({ kind: "app", port });
    } catch (err) {
      // The named refusal (the caps, the stale node answer) renders as asked.
      if (generation.current !== gen) return;
      setOpenError(errMessage(err, "Couldn't open a preview lane to that port."));
    }
  }

  // The Screen verb rides the SAME forward lane as Open (decision 6 makes the
  // rfbPort session raw on the plane; zero new protocol), and the viewer
  // mounts in the panel. The phone layout has no panel (spec §7), and the
  // phone-tier Screen control is disabled there with that reason, so this
  // handler is only ever reached with a panel that will host the viewer.
  async function handleScreen(): Promise<void> {
    if (!info?.screen) return;
    resumed.current = true;
    const gen = generation.current;
    setOpenError(null);
    try {
      const { proxyBase } = await preview.openPort(info.screen.rfbPort);
      if (generation.current !== gen) return;
      setOpen(null);
      if (preview.watching) await preview.stopWatch();
      if (generation.current !== gen) return;
      setScreenSession({ display: info.screen.display, proxyBase });
      onViewChange?.({ kind: "screen" });
      // A fresh session is exactly when the info poll should be re-asked:
      // its own throttle still rules (spec §7).
      preview.refresh();
    } catch (err) {
      if (generation.current !== gen) return;
      setOpenError(errMessage(err, "Couldn't open a screen preview lane."));
    }
  }

  const reopen = useRef({ handleOpen, handleScreen, startWatch: preview.startWatch });
  reopen.current = { handleOpen, handleScreen, startWatch: preview.startWatch };
  useEffect(() => {
    if (resumed.current || !initialView || !info?.nodeEnabled || info.reason) return;
    resumed.current = true;
    if (initialView.kind === "app") void reopen.current.handleOpen(initialView.port);
    else if (initialView.kind === "screen") void reopen.current.handleScreen();
    else void reopen.current.startWatch(info.cdpPort ?? undefined);
  }, [initialView, info]);

  // The info poll is what carries a vanished browser (spec §5): the named
  // state renders beside the canvas, and the canvas stays where it was.
  const browserGone = preview.watching && info != null && info.cdpPort === null;
  const hasViewer = Boolean((open && !phone) || screenSession || preview.watching);
  const nothingToPreview =
    info?.nodeEnabled &&
    !info.reason &&
    info.ports.length === 0 &&
    info.screen === null &&
    info.screenLost === undefined &&
    !preview.watching;

  return (
    <section
      aria-label="Preview"
      ref={sectionRef}
      className={cn(
        "flex min-h-0 shrink-0 flex-col gap-3 border-border border-t bg-card p-3",
        fill
          ? "h-full w-full overflow-hidden"
          : hasViewer
            ? "h-[55%] max-h-[85%] min-h-40 resize-y overflow-hidden"
            : "max-h-[45%] overflow-y-auto",
        "[&:fullscreen]:h-screen [&:fullscreen]:max-h-none [&:fullscreen]:resize-none",
      )}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <h2 className="font-strong text-label">Preview</h2>
        <Button variant="ghost" size="sm" onClick={preview.refresh}>
          Refresh
        </Button>
        {hasViewer && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void toggleFullscreen()}
            disabled={!sectionRef.current?.requestFullscreen}
            disabledReason="Your browser doesn't support full screen."
          >
            {fullscreen ? "Exit full screen" : "Full screen"}
          </Button>
        )}
        {onHide && (
          <Button variant="ghost" size="sm" onClick={onHide} aria-expanded={true}>
            Hide preview
          </Button>
        )}
        {preview.infoLoading && info === undefined && (
          <span className="text-detail text-muted-foreground">Checking what the pane offers…</span>
        )}
      </div>

      {notice && <TrustNoticeBanner notices={[notice]} visibleMs={bannerVisibleMs} />}

      {/* The switch's remedy line: the info answer is always the full shape,
          so a switched-off node says so in words rather than showing a blank
          list that reads as "nothing is listening". */}
      {info && (!info.nodeEnabled || info.reason) && (
        <p className="text-detail text-muted-foreground">{nodeReasonLine(info.reason)}</p>
      )}

      {info?.reason === "preview-disabled" && subshell && (
        <Link
          to="/nodes/$id"
          params={{ id: subshell.nodeId ?? "local" }}
          className="text-detail text-primary underline"
        >
          Open node settings
        </Link>
      )}
      {info && (
        <details open={!open && !screenSession && !preview.watching} className="max-h-[45%] shrink-0 overflow-y-auto">
          <summary className="cursor-pointer text-detail text-muted-foreground">Ports and screens</summary>
          <PortList
            info={info}
            access={access}
            watching={preview.watching}
            onOpen={(port) => void handleOpen(port)}
            onWatch={() => {
              resumed.current = true;
              setOpen(null);
              setScreenSession(null);
              onViewChange?.({ kind: "browser" });
              void preview.startWatch(info.cdpPort ?? undefined);
            }}
            onScreen={() => void handleScreen()}
            phone={phone}
          />
        </details>
      )}

      {nothingToPreview && (
        <p className="text-detail text-muted-foreground">Nothing to preview yet. Ports the pane opens show up here.</p>
      )}

      {preview.watchError && (
        <p role="alert" className="text-destructive text-detail">
          {preview.watchError}
        </p>
      )}
      {openError && (
        <p role="alert" className="text-destructive text-detail">
          {openError}
        </p>
      )}
      {preview.error && (
        <p role="alert" className="text-destructive text-detail">
          {preview.error}
        </p>
      )}

      {/* Keep Stop beside the picture when its port row is collapsed or disappears. */}
      {preview.watching && (
        <WatchViewer
          paneId={paneId}
          gone={browserGone}
          onStop={() => {
            onViewChange?.(null);
            void preview.stopWatch();
          }}
        />
      )}

      {open && phone && (
        <a href={open.proxyBase} target="_blank" rel="noreferrer" className="text-label text-primary underline">
          Open port {open.port} in new tab
        </a>
      )}
      {/* A real link keeps phone navigation inside a user gesture even after a slow request. */}
      {open && !phone && (
        <OpenPanel
          port={open.port}
          proxyBase={open.proxyBase}
          onClose={() => {
            onViewChange?.(null);
            setOpen(null);
          }}
        />
      )}

      {/* The Screen viewer is a panel too, so it follows the same mobile rule.
          Keyed on the session's proxy: a re-open is a fresh socket on a fresh
          mount, never a re-connect over a stale one (the viewer's whole
          construction assumes a new WebSocket per mount). */}
      {screenSession && !phone && (
        <ScreenViewer
          key={screenSession.proxyBase}
          display={screenSession.display}
          proxyBase={screenSession.proxyBase}
          onClose={() => {
            onViewChange?.(null);
            setScreenSession(null);
          }}
        />
      )}
    </section>
  );
}
