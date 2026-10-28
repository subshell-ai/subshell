import { errMessage } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import { isSwitchOff, NodeUnavailableNote } from "@/components/preview/node-unavailable-note";
import { OpenPanel } from "@/components/preview/open-panel";
import { PortList } from "@/components/preview/port-list";
import { PreviewSettingsDialog } from "@/components/preview/preview-settings-dialog";
import {
  type PreviewConnection,
  PreviewToolbar,
  type PreviewWorkspaceControls,
} from "@/components/preview/preview-toolbar";
import { ScreenViewer } from "@/components/preview/screen-viewer";
import { WatchViewer } from "@/components/preview/watch-viewer";
import { TrustNoticeBanner } from "@/components/trust-notice-banner";
import type { UseSubshellPreview } from "@/hooks/use-subshell-preview";
import type { TrustNotice } from "@/lib/trust-notices";
import type { SubshellAccess, SubshellView } from "@/types/subshell";

/**
 * One workspace preview tab (spec §7): a single app, browser watch, or screen
 * fills the panel, driven by the chooser's `initialView` or by a row press
 * while nothing is up yet.
 *
 * The band that used to sit under every terminal is gone (operator ruling
 * 2026-10-26): the header's icon raises the same list with the same reasons,
 * and a preview now only ever opens as a tab - on phones too, so no viewer
 * shape here branches on the layout.
 *
 * It is presentational by choice: the dock's tab content owns `useSubshellPreview`
 * and hands the controller down, which keeps every protocol half (the REST/
 * socket dance, the throttle) in the hook where it can be tested without
 * DOM. This file only decides what the truth looks like: which row carries
 * which control, what a gate says, and where the viewer renders.
 *
 * The disclosure is reuse, not a new subsystem: a shared pane's banner fires
 * once per device HERE TOO (its own dismiss key), because this surface shows
 * more than the terminal does - a live screen, not a log.
 */

export type PreviewChoice = import("@internal/subshell-protocol").WorkspacePreviewTarget;

export interface PreviewSectionProps {
  workspace?: PreviewWorkspaceControls;
  /** Closes the dock tab. */
  onClose: () => void;
  initialView?: PreviewChoice | null;
  /** The pane being previewed; watch frames key on it. */
  paneId: string;
  /** The caller's resolved access, exactly as the terminal reads it. */
  access: SubshellAccess;
  /** The row, for the shared-exposure disclosure. */
  subshell?: SubshellView;
  /** The hook's controller. */
  preview: UseSubshellPreview;
  /** Test seam for the banner's dwell, passed straight through. */
  bannerVisibleMs?: number;
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
  workspace,
  paneId,
  access,
  subshell,
  preview,
  bannerVisibleMs,
  initialView,
  onClose,
}: PreviewSectionProps): JSX.Element {
  const [open, setOpen] = useState<{ port: number; proxyBase: string; serviceId?: string } | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [connection, setConnection] = useState<PreviewConnection>("connecting");
  // The open screen session comes from the open answer, not from the info
  // poll: a later poll that reports the display gone must not disturb the
  // live viewer.
  const [screenSession, setScreenSession] = useState<{ protocol: "vnc"; proxyBase: string } | null>(null);
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
      setOpenError("Couldn't enter full screen. Your browser's own full-screen mode can give the view more room.");
    }
  }
  const [openError, setOpenError] = useState<string | null>(null);
  const info = preview.info;
  const notice = useMemo(() => previewSharedNotice(subshell), [subshell]);

  // Repointing this tab at another pane must drop everything that belongs to
  // the pane the user was looking at: carrying pane A's screen session into B
  // would render A's live VNC under B's name, and RFB's pump keeps pv-ws from
  // ever idling the lane (idle expiry needs a silent side), so A's forward
  // slot would stay pinned indefinitely. The Open panel and its error are the
  // same pane-scoped state.
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
    setConfiguring(false);
    setOpen(null);
    setOpenError(null);
    setBusy(false);
    return () => {
      generation.current += 1;
    };
  }, [paneId]);

  async function handleOpen(port: number, serviceId?: string): Promise<void> {
    resumed.current = true;
    const gen = generation.current;
    setOpenError(null);
    setBusy(true);
    setConnection("connecting");
    try {
      const { proxyBase } = await preview.openPort(port, serviceId);
      if (generation.current !== gen) return;
      setScreenSession(null);
      if (preview.watching) await preview.stopWatch();
      if (generation.current !== gen) return;
      setOpen({ port, proxyBase, serviceId });
    } catch (err) {
      // The named refusal (the caps, the stale node answer) renders as asked.
      if (generation.current !== gen) return;
      setOpenError(errMessage(err, "Couldn't connect to that app."));
    } finally {
      if (generation.current === gen) setBusy(false);
    }
  }

  // Screen shares the app forwarding path, with a raw RFB lane.
  async function handleScreen(): Promise<void> {
    if (!info?.screen) return;
    resumed.current = true;
    const gen = generation.current;
    setOpenError(null);
    setBusy(true);
    setConnection("connecting");
    try {
      const { proxyBase } = await preview.openPort(info.screen.viewer.port);
      if (generation.current !== gen) return;
      setOpen(null);
      if (preview.watching) await preview.stopWatch();
      if (generation.current !== gen) return;
      setScreenSession({ protocol: info.screen.viewer.protocol, proxyBase });
      // A fresh session is exactly when the info poll should be re-asked:
      // its own throttle still rules (spec §7).
      preview.refresh();
    } catch (err) {
      if (generation.current !== gen) return;
      setOpenError(errMessage(err, "Couldn't connect to the virtual display."));
    } finally {
      if (generation.current === gen) setBusy(false);
    }
  }

  async function handleWatch(): Promise<void> {
    resumed.current = true;
    const gen = generation.current;
    setOpen(null);
    setScreenSession(null);
    setConnection("connecting");
    setBusy(true);
    try {
      await preview.startWatch(info?.cdpPort ?? undefined);
    } finally {
      if (generation.current === gen) setBusy(false);
    }
  }

  function refreshViewer() {
    if (open) {
      setConnection("connecting");
      setReloadKey((value) => value + 1);
    } else if (screenSession) void handleScreen();
    else if (preview.watching) void handleWatch();
    else if (initialView?.kind === "app") void handleOpen(initialView.port);
    else if (initialView?.kind === "service") void handleOpen(initialView.port, initialView.serviceId);
    else if (initialView?.kind === "screen") void handleScreen();
    else if (initialView?.kind === "browser") void handleWatch();
    preview.refresh();
  }

  const reopen = useRef({ handleOpen, handleScreen, startWatch: handleWatch });
  reopen.current = { handleOpen, handleScreen, startWatch: handleWatch };
  useEffect(() => {
    if (resumed.current || !initialView || !info?.nodeEnabled || (info.reason && initialView.kind !== "service"))
      return;
    if (initialView.kind === "screen" && (!info.screen || info.virtualDisplayEnabled === false)) return;
    if (initialView.kind !== "screen" && info.webPreviewsEnabled === false) return;
    // Wait until mount effects settle, so StrictMode's replay cannot consume
    // the shortcut while invalidating its in-flight viewer request.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || resumed.current) return;
      resumed.current = true;
      if (initialView.kind === "app") void reopen.current.handleOpen(initialView.port);
      else if (initialView.kind === "service") void reopen.current.handleOpen(initialView.port, initialView.serviceId);
      else if (initialView.kind === "screen") void reopen.current.handleScreen();
      else void reopen.current.startWatch();
    });
    return () => {
      cancelled = true;
    };
  }, [initialView, info]);

  // The info poll is what carries a vanished browser (spec §5): the named
  // state renders beside the canvas, and the canvas stays where it was.
  const browserGone = preview.watching && info != null && info.cdpPort === null;
  const hasViewer = Boolean(open || screenSession || preview.watching);
  const selected = open ? `app:${open.port}` : screenSession ? "screen" : preview.watching ? "browser" : null;
  const nothingToPreview =
    info?.nodeEnabled &&
    !info.reason &&
    info.ports.length === 0 &&
    info.screen === null &&
    info.screenLost === undefined &&
    !preview.watching;

  return (
    <section
      aria-label="Web previews & screens"
      ref={sectionRef}
      className="flex h-full max-h-full min-h-0 w-full shrink-0 flex-col overflow-hidden bg-card [&:fullscreen]:h-screen [&:fullscreen]:max-h-none [&:fullscreen]:resize-none"
    >
      {(selected || initialView) && (
        <PreviewToolbar
          workspace={workspace}
          selected={selected}
          busy={busy}
          connection={connection}
          onRefresh={refreshViewer}
          onDisconnect={onClose}
          onFullscreen={() => void toggleFullscreen()}
          fullscreen={fullscreen}
          fullscreenSupported={Boolean(sectionRef.current?.requestFullscreen)}
          appUrl={open?.proxyBase}
          onConfigure={open && access !== "view" ? () => setConfiguring(true) : undefined}
        />
      )}

      {configuring && open && (
        <PreviewSettingsDialog
          paneId={paneId}
          port={open.port}
          serviceId={open.serviceId}
          onClose={() => setConfiguring(false)}
          onOpen={() => handleOpen(open.port, open.serviceId)}
        />
      )}
      {!selected && (busy || !info) && (
        <p role="status" className="p-3 text-detail text-muted-foreground">
          {busy ? "Opening view…" : "Checking available views…"}
        </p>
      )}

      {initialView?.kind === "screen" && info?.nodeEnabled && !info.reason && !info.screen && !screenSession && (
        <p className="p-3 text-detail text-muted-foreground">
          {info.virtualDisplayEnabled === false
            ? "Virtual displays are disabled in this node’s settings."
            : "This virtual display is no longer available. Restart the subshell with Virtual display enabled to create a new one."}
        </p>
      )}

      {initialView && initialView.kind !== "screen" && info?.webPreviewsEnabled === false && (
        <p className="p-3 text-detail text-muted-foreground">Web previews are disabled in this node’s settings.</p>
      )}

      {notice && <TrustNoticeBanner notices={[notice]} visibleMs={bannerVisibleMs} />}

      {/* The switch's remedy line: the info answer is always the full shape,
          so a switched-off node says so in words rather than showing a blank
          list that reads as "nothing is listening". */}
      {info && <NodeUnavailableNote info={info} className="p-3" />}

      {isSwitchOff(info?.reason) && subshell && (
        <Link
          to="/nodes/$id"
          params={{ id: subshell.nodeId ?? "local" }}
          className="text-detail text-primary underline"
        >
          Open node settings
        </Link>
      )}

      {/* The chooser's shape inside a tab: until something is up, the tab IS
          the list; the viewer replaces it the moment one opens. */}
      {info && !hasViewer && !initialView && (
        <div className="overflow-y-auto p-3">
          <PortList
            info={info}
            access={access}
            watching={preview.watching}
            onOpen={(port) => void handleOpen(port)}
            onWatch={() => void handleWatch()}
            onScreen={() => void handleScreen()}
            busy={busy}
          />
        </div>
      )}

      {nothingToPreview && !initialView && (
        <p className="text-detail text-muted-foreground">No apps or screens yet. Ports the pane opens show up here.</p>
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

      {preview.watching && <WatchViewer paneId={paneId} onConnectionChange={setConnection} gone={browserGone} />}

      {open && (
        <OpenPanel
          port={open.port}
          reloadKey={reloadKey}
          onConnectionChange={setConnection}
          proxyBase={open.proxyBase}
        />
      )}

      {/* The Screen viewer is a panel too. Keyed on the session's proxy: a
          re-open is a fresh socket on a fresh mount, never a re-connect over a
          stale one (the viewer's own construction assumes a new WebSocket per
          mount). */}
      {screenSession && (
        <ScreenViewer
          key={screenSession.proxyBase}
          onConnectionChange={setConnection}
          protocol={screenSession.protocol}
          proxyBase={screenSession.proxyBase}
        />
      )}
    </section>
  );
}
