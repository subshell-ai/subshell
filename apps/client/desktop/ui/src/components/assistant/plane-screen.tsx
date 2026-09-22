/**
 * Control Plane — the rail section holding the planes this app can connect to
 * (operator ruling 2026-09-22: "the control plane section is for connecting
 * to other control planes, not necessarily tied with the node"). Rows open
 * with one press and nothing about a press is remembered: there is no
 * "current" plane and no boot-open, because a client never opens a control
 * plane's dashboard by itself (spec 2026-09-18 § 2). The list is bookmarks
 * with doors.
 *
 * The rulings of the same day that shaped the frame: not a card, a bare
 * table; the add lives in the frame's 72px bottom bar; and the `⋮` is an
 * ACTION MENU, not an in-flow show/hide (third ruling, 2026-09-22). That one
 * is worth the mechanic in the comment, because the first cut of this screen
 * rejected menus on CSP grounds and was right about the grounds and wrong
 * about the consequence: the bundle's CSP carries no `style-src
 * 'unsafe-inline'`, which blocks STYLE ATTRIBUTES, so a positioning primitive
 * that floats a panel by writing a `style` attribute renders unstyled in the
 * wrong place (the `confirm-panel.tsx` note records the measurement). What it
 * does not block is CLASS-BASED positioning, and a list row does not need a
 * measuring popper: the panel is `absolute right-0 top-full` inside the row's
 * own `relative` box. A real menu — `role=menu`, `menuitem`s, Escape and
 * outside-press dismiss — out of nothing but tokens.
 *
 * Two kinds of row:
 *
 * - **The node's address.** `probe.status.serverUrl` renders as a PINNED
 *   first row badged "this node". Its menu holds the SAME opens as any row
 *   (operator note, 2026-09-22: "what about open in browser?" — the pinned
 *   row is a plane like any other to CONNECT to); only the third item
 *   differs, because the address belongs to the node's own configuration and
 *   Rust refuses to store it as an entry (one row per plane). Where a stored
 *   row offers Remove, the pinned row shows the note that points at the
 *   Service section, where the node's acts (repoint, the lifecycle verbs,
 *   and the un-enroll that follows) live. That is the ruling's split said in
 *   the interface: connecting is this section's business; being a node is
 *   Service's.
 * - **A stored address.** Its menu: "Open in dashboard", "Open in browser",
 *   "Remove" (confirmed, and confirmable nothing more: the app's bookmarks
 *   are its whole reach).
 *
 * The add's grammar is the bar's own: opener primary-right when closed;
 * open, the field sits at the foot of the table where the new row will
 * appear, Add takes the primary spot, and Cancel goes ghost-left.
 *
 * The list is the app's own settings, canonical spellings, deduped by the
 * Rust side that validates every add. The add form SAVES only — the refetched
 * list is the entire validation and dedupe feedback — and the section's doors
 * are the rows themselves: no affordance repeats what the list can already
 * open. The `bundled` and `tmux` fact rows are NOT here (screenshot 52): they
 * render on Service and Status.
 */
import { MoreVertical } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { ActionOutput } from "@/components/assistant/status-facts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { NodeCommands } from "@/hooks/use-node-commands";
import type { ActionResult, NodeSettings, Probe } from "@/lib/ipc";

export function PlaneScreen(props: {
  shell: FrameShell;
  /** The rail node the app computed for this screen, or undefined when the screen is full-window. */
  rail?: ReactElement;
  probe: Probe | undefined;
  settings: NodeSettings | undefined;
  commands: NodeCommands;
  busy: boolean;
  /** Open the Service section — where the pinned row's note sends a detaching person. */
  onGoToService: () => void;
  /** The acts' own words — refusals included, as the section's output block. */
  output: ActionResult | null;
}): ReactElement {
  const { shell, probe, settings, commands, busy, onGoToService, output } = props;
  const nodeUrl = probe?.status?.serverUrl ?? null;
  // Display guard against a stored row spelling the node's own address in a
  // way Rust's canonical compare never saw (a CLI re-point can leave two
  // spellings behind): the pinned row renders it, the list does not repeat it.
  const planes = (settings?.planes ?? []).filter((p) => p !== nodeUrl);
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState("");
  // Which row's menu is open. One at a time: two open menus over a list is a
  // maze, and opening a menu is always deliberate.
  const [menuUrl, setMenuUrl] = useState<string | null>(null);

  // The menu's own dismissal protocol. Each listener is mounted only while a
  // menu is open, and the trigger plus its panel are marked as one island
  // (`data-plane-menu` on the row) so the press that opened the menu is not
  // also the outside press that closes it.
  useEffect(() => {
    if (menuUrl === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuUrl(null);
    };
    const onDown = (e: Event) => {
      if (e.target instanceof Element && e.target.closest("[data-plane-menu]")) return;
      setMenuUrl(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [menuUrl]);

  const open = (url: string) => {
    setMenuUrl(null);
    commands.openPlane(url);
  };

  // The save, from either door: the bar's Add press and Enter in the field
  // (whose implicit submission the form's own onSubmit answers). Closed
  // unconditionally: a rejection (a bad URL, the node's own address)
  // surfaces as the runner's own message, and leaving the form open on
  // success would look like nothing happened.
  const submitAdd = () => {
    if (busy || typed.trim() === "") return;
    setAdding(false);
    commands.addPlane(typed);
  };

  const item = (label: string, act: () => void): ReactElement => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      role="menuitem"
      className="w-full justify-start"
      disabled={busy}
      onClick={act}
    >
      {label}
    </Button>
  );

  const row = (url: string, pinned: boolean): ReactElement => (
    <div className="relative border-border border-b py-2 last:border-b-0" key={url} data-plane-menu="">
      <div className="flex items-center gap-2">
        {/* The row itself IS the door: clicking opens the dashboard
            (operator's shape, 2026-09-22), so the address reads as a button
            rather than needing a menu item to say the obvious. */}
        <Button
          variant="ghost"
          size="sm"
          className="min-w-0 flex-1 justify-start px-0 font-mono text-sm hover:underline"
          disabled={busy}
          onClick={() => open(url)}
        >
          <span className="min-w-0 break-all text-left">{url}</span>
        </Button>
        {pinned && <Badge variant="secondary">this node</Badge>}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          aria-label={`Actions for ${url}`}
          aria-haspopup="menu"
          aria-expanded={menuUrl === url}
          onClick={() => setMenuUrl(menuUrl === url ? null : url)}
        >
          <MoreVertical aria-hidden />
        </Button>
      </div>
      {menuUrl === url && (
        <div
          role="menu"
          aria-label={`Actions for ${url}`}
          className="absolute right-0 top-full z-50 mt-1 min-w-56 rounded-md border border-border bg-card p-1 shadow-lg"
        >
          {item("Open in dashboard", () => open(url))}
          {item("Open in browser", () => {
            setMenuUrl(null);
            commands.openPlaneUrl(url);
          })}
          {pinned ? (
            <>
              <p className="px-2 py-1.5 text-detail text-muted-foreground leading-relaxed">
                This is the control plane this machine&rsquo;s node reports to. To detach this machine, go to Service
                and un-enroll or uninstall the node.
              </p>
              {item("Go to Service", () => {
                setMenuUrl(null);
                onGoToService();
              })}
            </>
          ) : (
            item("Remove", () => {
              setMenuUrl(null);
              commands.removePlane(url);
            })
          )}
        </div>
      )}
    </div>
  );

  return (
    <Frame
      {...shell}
      rail={props.rail}
      barLeft={
        adding ? (
          <Button
            variant="ghost"
            onClick={() => {
              setAdding(false);
              setTyped("");
            }}
          >
            Cancel
          </Button>
        ) : undefined
      }
      barRight={
        adding ? (
          // The bar's primary calls the form's save directly; the field's
          // Enter reaches the same handler through the form's onSubmit.
          <Button type="button" onClick={submitAdd} disabled={busy || typed.trim() === ""}>
            Add
          </Button>
        ) : (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setTyped("");
              setAdding(true);
            }}
          >
            Add a control plane…
          </Button>
        )
      }
    >
      <div>
        {nodeUrl === null && planes.length === 0 && (
          <p className="text-detail text-muted-foreground">No control planes yet. Add an address to connect to one.</p>
        )}
        {nodeUrl !== null && row(nodeUrl, true)}
        {planes.map((p) => row(p, false))}
        {adding && (
          <form
            className="flex flex-col gap-2 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              submitAdd();
            }}
          >
            {/* The Label is a Label only while its input exists (delta
                review m-3): a htmlFor with no control in the tree is dead
                pointing. */}
            <Label htmlFor="plane-add-url" className="font-strong text-detail">
              Control plane URL
            </Label>
            <Input
              id="plane-add-url"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="https://subshell.example.com"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              disabled={busy}
            />
          </form>
        )}
      </div>

      {/* The acts' own words, INLINE — refusals from the opens and the saves
          included (the facts list is Status's alone, ruling screenshot 60). */}
      <ActionOutput output={output} />
    </Frame>
  );
}
