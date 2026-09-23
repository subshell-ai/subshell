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
 * own `relative` box, at a FIXED width — shrink-to-fit there is not an option
 * (live-window ruling 2026-09-22, "why is the action menu so wide"): the
 * engine sized the auto-width panel against the row's full available width
 * once its `w-full` items were counted in, so the menu read as a banner
 * across the card. A real menu — `role=menu`, `menuitem`s, Escape and
 * outside-press dismiss — out of nothing but tokens.
 *
 * Two kinds of row:
 *
 * - **The node's address.** `probe.status.serverUrl` renders as a PINNED
 *   first row badged "this node". Its menu holds the SAME items as any row
 *   (operator notes, 2026-09-22: "what about open in browser?" — the pinned
 *   row is a plane like any other to CONNECT to) and then stops: no Remove,
 *   because the address belongs to the node's own configuration and Rust
 *   refuses to store it as an entry, and no sentence explaining the absence
 *   either (same day, from the live window: the pointer note was deleted
 *   once Un-enroll… stood up on Service — the act has its door there, and
 *   absence is the whole message here).
 * - **A stored address.** Its menu adds "Remove" (confirmed, and confirmable
 *   nothing more: the app's bookmarks are its whole reach).
 *
 * Every menu: Open in dashboard, Open in browser, **Copy URL**, and — stored
 * rows only — Remove. Copy is the CopyButton affordance in text form: the
 * dismiss is the success flash, and a refused clipboard keeps the menu open
 * and says so in the item's own label rather than flashing nothing.
 *
 * The add's opener is the bar's own primary-right slot; the FORM is a
 * dialog (operator ruling 2026-09-22, the dialog audit's last inline pane),
 * and — like every save after it — it CLOSES on submit: the refetched list
 * appearing beneath is the feedback, and a refused add lands on the
 * section's output block in Rust's verbatim words.
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
import { Dialog } from "@/components/ui/dialog";
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
  /** Open the Service section — the pinned row's menu offers the route as
   *  an item (the explanatory sentence was deleted; the pointer stayed). */
  onGoToService: () => void;
  /** The acts' own words — refusals included, as the section's output block. */
  output: ActionResult | null;
}): ReactElement {
  const { shell, probe, settings, commands, busy, onGoToService, output } = props;
  // The node's reporting address in the shape the stored list holds: Rust
  // canonicalized every stored entry on the way in (lowercase scheme and
  // host, no trailing slash, origin only), while the probe echoes this
  // machine's config file, which a hand-edit can spell any way. Comparing
  // raw left a `HTTPS://x.example/` config rendering TWO rows for one plane
  // — a removable one and the pinned one — with the pinned row showing the
  // un-canonical spelling (merged-wave review; the tray canonicalizes before
  // its compare, this row now does the same). An unparseable value keeps
  // itself: the pinned row still says what the config says.
  const nodeUrl = (() => {
    const raw = probe?.status?.serverUrl;
    if (!raw) return null;
    try {
      return new URL(raw).origin;
    } catch {
      return raw;
    }
  })();
  // Display guard against a stored row spelling the node's own address in a
  // way Rust's canonical compare never saw (a CLI re-point can leave two
  // spellings behind): the pinned row renders it, the list does not repeat it.
  const planes = (settings?.planes ?? []).filter((p) => p !== nodeUrl);
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState("");
  // Which row's menu is open. One at a time: two open menus over a list is a
  // maze, and opening a menu is always deliberate.
  const [menuUrl, setMenuUrl] = useState<string | null>(null);
  // A refused clipboard. It keeps the menu OPEN and renames the item, because
  // a press that dismissed on failure would flash nothing and read as one
  // that never registered (the `CopyButton` argument, in text form).
  const [copyFailed, setCopyFailed] = useState<string | null>(null);

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

  // The save, from either door: the dialog's Add press and Enter in the
  // field (whose implicit submission the form's own onSubmit answers).
  // Closed unconditionally: a rejection (a bad URL, the node's own address)
  // surfaces on the section's output block, and leaving the dialog open on
  // success would look like nothing happened — the refetched list is the
  // entire validation and dedupe feedback.
  const submitAdd = () => {
    if (busy || typed.trim() === "") return;
    const url = typed;
    setAdding(false);
    setTyped("");
    commands.addPlane(url);
  };

  const copyUrl = (url: string) => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(url);
        setMenuUrl(null);
      } catch {
        setCopyFailed(url);
      }
    })();
  };

  // Dense menu-item scale: shorter than the app's smallest BUTTON (h-8),
  // detail-size text, left-aligned — a menu is read, not pressed like a
  // toolbar (live-window ruling 2026-09-22: the first cut sized items like
  // buttons and the whole panel read oversized).
  const item = (label: string, act: () => void): ReactElement => (
    <Button
      type="button"
      variant="ghost"
      role="menuitem"
      className="h-7 w-full justify-start rounded-sm px-2 font-regular text-detail"
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
          onClick={() => {
            setCopyFailed(null);
            setMenuUrl(menuUrl === url ? null : url);
          }}
        >
          <MoreVertical aria-hidden />
        </Button>
      </div>
      {menuUrl === url && (
        <div
          role="menu"
          aria-label={`Actions for ${url}`}
          className="absolute top-full right-0 z-50 mt-1 w-48 rounded-md border border-border bg-card p-1 shadow-lg"
        >
          {item("Open in dashboard", () => open(url))}
          {item("Open in browser", () => {
            setMenuUrl(null);
            commands.openPlaneUrl(url);
          })}
          {item(copyFailed === url ? "Couldn't copy, try again" : "Copy URL", () => copyUrl(url))}
          {pinned
            ? // The pointer, not a sentence: detaching lives on Service, and
              // the menu says so in one item (the explanatory paragraph was
              // deleted by ruling; the ROUTE stayed).
              item("Go to Service", () => {
                setMenuUrl(null);
                onGoToService();
              })
            : item("Remove", () => {
                setMenuUrl(null);
                commands.removePlane(url);
              })}
        </div>
      )}
    </div>
  );

  return (
    <Frame
      {...shell}
      rail={props.rail}
      barRight={
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
      }
    >
      <div>
        {nodeUrl === null && planes.length === 0 && (
          <p className="text-detail text-muted-foreground">No control planes yet. Add an address to connect to one.</p>
        )}
        {nodeUrl !== null && row(nodeUrl, true)}
        {planes.map((p) => row(p, false))}
      </div>
      {adding && (
        <Dialog title="Add a control plane" onClose={() => setAdding(false)}>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitAdd();
            }}
          >
            {/* The Label is a Label only while its input exists (delta
                review m-3): a htmlFor with no control in the tree is dead
                pointing. */}
            <Label htmlFor="plane-add-url" className="text-detail text-muted-foreground">
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
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setAdding(false);
                  setTyped("");
                }}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy || typed.trim() === ""}>
                Add
              </Button>
            </div>
          </form>
        </Dialog>
      )}

      {/* The acts' own words, INLINE — refusals from the opens and the saves
          included (the facts list is Status's alone, ruling screenshot 60). */}
      <ActionOutput output={output} />
    </Frame>
  );
}
