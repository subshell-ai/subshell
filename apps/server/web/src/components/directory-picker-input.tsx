import { BackendErrorCodes } from "@internal/backend-errors";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, ChevronRight, FolderOpen, Star } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { PermissionNotice } from "@/components/desktop/permission-notice";
import { Input } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { desktopPlatform, isServerDesktop } from "@/lib/desktop";
import { SERVER_DEPLOYMENT_QUERY_KEY } from "@/lib/query-keys";
import { currentMode } from "@/lib/supervision";
import type { ExploreResult } from "@/types/files";
import type { ServerDeployment } from "@/types/server-deployment";

/**
 * Which name macOS showed in the prompt for a folder this server cannot read.
 *
 * Under the launchd service the prompt names the binary, `subshell-server`;
 * with the desktop app supervising its own child it names the app. Saying the
 * wrong one sends a person to look for a row that is not in the list — and a
 * prompt naming a binary they never typed is the one that looks like malware,
 * which is exactly why it has to be named at all.
 *
 * Unknown reads as the binary: the deployment view is admin-only, so most
 * viewers have no answer, and the service is the deployment a non-admin is
 * overwhelmingly likely to be looking at.
 */
export function blockedByName(deployment: ServerDeployment | undefined): string {
  return deployment && currentMode(deployment) === "app" ? "Subshell Server" : "subshell-server";
}

/**
 * A text input for an absolute directory path that expands the server-side
 * folder picker (container paths) the moment it is clicked. Shared by the
 * new-subshell form's working-directory field.
 *
 * Fully controlled: `value`/`onChange` come from the parent, and the panel
 * always shows the folder the input names. Every row click — folder, Recent,
 * or Favorites — selects the path AND browses the panel to it; nothing but
 * an outside click or Escape closes it. Typing in the input moves the open
 * panel to the typed path, and a path that does not exist says so in place
 * with a Start-over button that clears the field and returns to home.
 *
 * Every row carries a star (revealed on hover, solid for favorites) that
 * saves the path as a favorite without leaving the panel — the successor to
 * the removed bookmarks feature. Favorites render under Recent; a path the
 * user starred stops showing in Recent so nothing appears twice.
 *
 * When a `nodeId` is supplied (and is not `local`), the panel browses THAT
 * node's filesystem — the explore request carries `?node=<id>` exactly as the
 * recents hook does, so the picker follows the node selected in the new-
 * subshell form. The backend answers identically-shaped listings for either
 * transport; a node whose CLI predates remote browsing answers 409
 * `NODE_OUTDATED`, surfaced here as a clear update prompt.
 */
export function DirectoryPickerInput({
  id,
  value,
  onChange,
  placeholder,
  helper,
  nodeId,
  nodeName,
}: {
  /** Optional `id` for the input/label association. */
  id?: string;
  /** Current path value. */
  value: string;
  /** Called with the chosen/typed path. */
  onChange: (path: string) => void;
  /** Input placeholder. */
  placeholder?: string;
  /** Optional helper text rendered under the picker. */
  helper?: string;
  /** Browse this node instead of the control plane; `local`/undefined = local. */
  nodeId?: string;
  /** Human label for `nodeId`, shown in the too-old prompt when set. */
  nodeName?: string;
}) {
  // `local` (and an absent pick) mean the control plane — the node param is
  // then omitted entirely, keeping the request byte-identical to local.
  const remoteNode = nodeId && nodeId !== "local" ? nodeId : undefined;
  const remoteLabel = nodeName || remoteNode || "that node";
  const [pickerPath, setPickerPath] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // Typing in the input moves the open panel to the typed folder. The sync
  // is debounced so a burst of keystrokes — most of them paths that don't
  // exist yet — fires at most one explore fetch. Panel clicks that change
  // `value` set `lastTypedRef` themselves: the change is not typing, and a
  // stale timer must not later yank the panel back up the tree.
  const lastTypedRef = useRef(value);
  useEffect(() => {
    if (!pickerOpen) {
      lastTypedRef.current = value;
      return;
    }
    if (value === lastTypedRef.current) return;
    const timer = setTimeout(() => {
      lastTypedRef.current = value;
      setPickerPath(value || "~");
    }, 250);
    return () => clearTimeout(timer);
  }, [value, pickerOpen]);

  // The panel is dismissed by anything outside it, or by Escape. Both
  // listeners live with `pickerOpen` so an idle field costs nothing.
  useEffect(() => {
    if (!pickerOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setPickerOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setPickerOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pickerOpen]);

  // The node rides the query key too: the same path on a different machine
  // is a different listing, and switching nodes mid-open must refetch.
  const { data: explore, error } = useQuery({
    queryKey: remoteNode ? (["explore", remoteNode, pickerPath] as const) : (["explore", pickerPath] as const),
    queryFn: () =>
      apiFetch<ExploreResult>(
        `/api/files/explore?path=${encodeURIComponent(pickerPath)}${
          remoteNode ? `&node=${encodeURIComponent(remoteNode)}` : ""
        }`,
      ),
    enabled: pickerOpen,
  });
  // A typed path that does not exist (404) is a different message from a
  // browse failure (500/forbidden/network): one invites a correction, the
  // other only explains. A too-old node (409 NODE_OUTDATED) is neither —
  // nothing about the path or a retry helps; the node itself must update.
  const notFound = error instanceof ApiError && error.status === 404;
  // Read from the CACHE, never fetched: `GET /api/admin/server` is admin-only,
  // so a request from here would 403 for most viewers to decide one word. The
  // Service page is what fills this, and `undefined` is a fine answer.
  const deployment = queryClient.getQueryData<ServerDeployment>(SERVER_DEPLOYMENT_QUERY_KEY);
  // Two independent ways to KNOW the machine being browsed is a Mac, and
  // either is enough (review, 2026-09-14). The shell answers it for the person
  // sitting at the machine; the deployment view answers it for an admin in a
  // browser, which is the reading most of these refusals get looked at from.
  // With neither — a browser with no cached view, a Linux shell — a refused
  // folder may be plain unix modes, and naming macOS would be a guess about a
  // machine this page cannot see.
  //
  // Both signals describe the CONTROL PLANE, so neither says anything while
  // another machine's filesystem is on screen: a Linux node browsed from a Mac
  // plane would otherwise be told macOS blocked it.
  const serverOnMac =
    !remoteNode && ((isServerDesktop() && desktopPlatform() === "macos") || deployment?.platform === "darwin");
  const nodeOutdated = error instanceof ApiError && error.code === BackendErrorCodes.NODE_OUTDATED;

  /** Stars/unstars a path; sections refresh from the same responses. */
  const favorite = useMutation({
    mutationFn: ({ path, on }: { path: string; on: boolean }) =>
      apiFetch("/api/files/favorite", { method: "PATCH", body: JSON.stringify({ path, favorite: on }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["explore"] });
      void queryClient.invalidateQueries({ queryKey: ["recent-paths"] });
    },
  });

  function openPicker() {
    setPickerPath(value || "~");
    setPickerOpen(true);
  }

  /**
   * Selects `path` — it becomes the input's value — and browses into it,
   * keeping the panel open. Claiming the change in `lastTypedRef` first is
   * what keeps this self-inflicted `value` change from being mistaken for
   * typing by the sync effect above.
   */
  function pick(path: string) {
    lastTypedRef.current = path;
    onChange(path);
    setPickerPath(path);
  }

  /**
   * Gives up on a path that does not exist: the input is cleared and the
   * panel restarts at the home directory, so the next move is a fresh browse
   * rather than an edit of the dead path.
   */
  function startOver() {
    lastTypedRef.current = "";
    onChange("");
    setPickerPath("~");
  }

  return (
    <div ref={rootRef} className="space-y-2">
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={openPicker}
        placeholder={placeholder}
      />

      {/* The panel opens the moment the input is focused. Rendering it only
          once a result exists made a slow or failed browse look like a dead
          field.

          IN FLOW, not an overlay (user report 2026-09-11: "the directory
          selector is cut off"). Every surface that hosts this field is now a
          scroll container — the launch dialog and the add-subshell dialog cap
          at `max-h-[85dvh] overflow-y-auto`, the setup assistant's screen
          scrolls too — and an absolutely positioned child of a scroll
          container is clipped at its edge BY CONSTRUCTION: `overflow-y: auto`
          forces the x axis to a scrolling value as well, so there is no
          "let this one child escape". Floating it correctly instead would
          mean measuring the room on every open and flipping the panel above
          the input when it does not fit, which is a positioning engine this
          hand-rolled picker does not have.

          The cost is honest and small: opening the panel pushes what is below
          it down, and a person who wants the buttons back dismisses the panel
          the same way they already did. The cut-off panel was unusable; a
          panel that moves the page is merely a panel. */}
      {pickerOpen && (
        <div className="mt-1 w-full rounded-md border bg-background p-2 shadow-md">
          {/* The body is exactly `h-56` in every state — listing, loading,
              error — with Recent and Favorites folded into the scroll area.
              A content-sized body grew and shrank as you moved between
              folders, so the panel jumped height on every navigation. */}
          {error ? (
            notFound ? (
              <div className="flex h-56 flex-col items-start justify-center gap-2 px-2 text-sm">
                <p className="text-destructive">
                  That path doesn&apos;t exist.{" "}
                  <span className="text-muted-foreground">Check the spelling, or start over.</span>
                </p>
                <button
                  type="button"
                  onClick={startOver}
                  className="rounded-md border px-2 py-1 text-detail text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  Start over
                </button>
              </div>
            ) : nodeOutdated ? (
              <div className="flex h-56 items-center px-2 text-sm">
                {/* One unbroken text run naming the machine — the remedy is
                    on the NODE (update the subshell app), so neither the
                    path correction nor Start over applies here. */}
                <p className="text-muted-foreground">
                  The subshell app on {remoteLabel} is too old to browse folders there. Update it.
                </p>
              </div>
            ) : (
              <div className="flex h-56 items-center px-2 text-destructive text-sm">
                Couldn&apos;t browse this path.
              </div>
            )
          ) : explore?.blocked === "permission" ? (
            // The folder EXISTS and is not empty — the OS refused the read.
            // Rendering it as an empty listing would say the opposite, and
            // the person would keep clicking into folders wondering why their
            // projects had vanished (operator's report, 2026-09-14).
            <div className="flex h-56 flex-col items-start justify-center gap-2 px-2">
              {/* The server flags EACCES as well as EPERM, on every platform, so
                  the copy names macOS only where this page can know the server
                  is on a Mac (review, 2026-09-14). */}
              <p className="text-sm">{serverOnMac ? "Blocked by macOS" : "Not allowed to read this folder"}</p>
              <PermissionNotice
                pane="files"
                message={
                  serverOnMac
                    ? `macOS is not letting ${blockedByName(deployment)} read this folder.`
                    : `${blockedByName(deployment)} was refused when it tried to list this folder.`
                }
              />
            </div>
          ) : explore ? (
            <div className="h-56 overflow-y-auto">
              {/* Saved paths first — Recent (top 3) over Favorites — each
                  section rendered only when it has rows. The directory
                  listing lives at the BOTTOM on purpose: a busy folder can
                  hold dozens of entries, and shortcuts buried under them
                  would be useless; the listing is the one section meant to
                  scroll. */}
              {explore.recent.length > 0 && (
                <div>
                  <p className="mb-1 px-2 text-detail text-muted-foreground">Recent</p>
                  {explore.recent.map((r) => (
                    <div key={r.path} className="group flex items-center">
                      <button
                        type="button"
                        title={r.path}
                        onClick={() => pick(r.path)}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent"
                      >
                        <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="truncate">{r.label ?? r.path}</span>
                      </button>
                      <StarButton
                        path={r.path}
                        starred={false}
                        onToggle={(on) => favorite.mutate({ path: r.path, on })}
                      />
                    </div>
                  ))}
                </div>
              )}
              {explore.favorites.length > 0 && (
                <div className={explore.recent.length > 0 ? "mt-2 border-t pt-2" : undefined}>
                  <p className="mb-1 px-2 text-detail text-muted-foreground">Favorites</p>
                  {explore.favorites.map((f) => (
                    <div key={f.path} className="group flex items-center">
                      <button
                        type="button"
                        title={f.path}
                        onClick={() => pick(f.path)}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent"
                      >
                        <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="truncate">{f.label ?? f.path}</span>
                      </button>
                      <StarButton path={f.path} starred onToggle={(on) => favorite.mutate({ path: f.path, on })} />
                    </div>
                  ))}
                </div>
              )}

              {(explore.parent !== null || explore.entries.length > 0) && (
                <div className="mt-2 border-t pt-2">
                  {/* One click per folder: it becomes the input's value and
                      the panel descends into it. */}
                  {explore.parent && (
                    <div className="group flex items-center">
                      <button
                        type="button"
                        title="Go up one level"
                        onClick={() => pick(explore.parent ?? "")}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent"
                      >
                        <ArrowUp className="h-3 w-3 shrink-0 text-muted-foreground" />
                        ..
                      </button>
                    </div>
                  )}
                  {explore.entries
                    .filter((e) => e.kind === "dir")
                    .map((e) => (
                      <div key={e.path} className="group flex items-center">
                        <button
                          type="button"
                          title={`Open ${e.name}`}
                          onClick={() => pick(e.path)}
                          className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent"
                        >
                          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                          <span className="truncate">{e.name}</span>
                        </button>
                        {/* Favorites are a control-plane concept (the table has
                            no node column — the remote browse ships its
                            Favorites section empty). Starring a node path
                            would plant a dead click in every later LOCAL
                            panel, so the star is simply not offered while
                            browsing another machine. */}
                        {!remoteNode && (
                          <StarButton
                            path={e.path}
                            starred={false}
                            onToggle={(on) => favorite.mutate({ path: e.path, on })}
                          />
                        )}
                      </div>
                    ))}
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-56 items-center px-2 text-muted-foreground text-sm">Loading…</div>
          )}
        </div>
      )}

      {helper && <p className="text-detail text-muted-foreground">{helper}</p>}
    </div>
  );
}

/**
 * The row's favorite toggle. Hidden until the row is hovered (or keyboard-
 * focused) so the list reads as text, but a starred row shows its solid star
 * always — the affordance to UN-star has to be discoverable. Clicking it
 * never selects the path or closes the panel.
 */
function StarButton({
  path,
  starred,
  onToggle,
}: {
  /** The path this star controls (also the accessible name). */
  path: string;
  /** True renders the solid star and unstars on click. */
  starred: boolean;
  /** Called with the desired favorite state. */
  onToggle: (on: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={`${starred ? "Unfavorite" : "Favorite"} ${path}`}
      title={starred ? "Remove from favorites" : "Save to favorites"}
      onClick={() => onToggle(!starred)}
      className={
        starred
          ? "shrink-0 rounded p-1 text-amber-400"
          : "shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      }
    >
      <Star className={starred ? "h-3.5 w-3.5 fill-current" : "h-3.5 w-3.5"} />
    </button>
  );
}
