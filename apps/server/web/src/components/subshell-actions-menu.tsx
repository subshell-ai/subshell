import { useNavigate } from "@tanstack/react-router";
import {
  Activity,
  ArrowLeftRight,
  Bell,
  BellOff,
  Copy,
  ExternalLink,
  Keyboard,
  QrCode,
  RotateCcw,
  Share2,
  SlidersHorizontal,
  TextCursorInput,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";
import { CloneSubshellDialog } from "@/components/clone-subshell-dialog";
import { QrLinkDialog } from "@/components/qr-link-dialog";
import { SharingDialog } from "@/components/sharing-dialog";
import { SwitchPresetDialog } from "@/components/switch-preset-dialog";
import { TitleDialog } from "@/components/ui/title-dialog";
import { usePresets } from "@/hooks/use-presets";
import { useSubshellMutations } from "@/hooks/use-subshell-mutations";
import { desktopInvoke, isDesktop } from "@/lib/desktop";
import type { SubshellView } from "@/types/subshell";

/**
 * Everything you can do to a subshell, behind the shared overflow menu.
 *
 * Shared by the tiled cards, the list rows, and the subshell page header so
 * every presentation of the same subshells offers the same actions, asks the
 * same questions before the destructive ones, and doesn't drift as either
 * grows. The mutations themselves live in `useSubshellMutations`, which the
 * terminal's exited-state panel uses too.
 */
export function SubshellActionsMenu({
  subshell,
  disabled,
  onDeleted,
  diagnostics,
  copyMode,
  children,
}: {
  subshell: SubshellView;
  /** Disables the trigger, e.g. while a bulk action is running over this row. */
  disabled?: boolean;
  /** Called after the subshell is deleted, e.g. to leave a now-dead detail page. */
  onDeleted?: () => void;
  /**
   * The Wave C diagnostics HUD toggle (spec 2026-09-21). Only the subshell
   * PAGE passes it: the HUD floats over that page's terminal, and the shared
   * presentations (cards, rows, the sidebar's right-click) have no terminal
   * to point a diagnostics switch at. The page owns the state and the
   * per-device persistence; the menu only offers the act.
   */
  diagnostics?: { on: boolean; onToggle: () => void };
  /**
   * The copy-mode toggle (issue 242): exactly the diagnostics posture — the
   * PAGE passes it, and only a TOUCH page (the menu adds no second gate),
   * because copy mode is what lets a finger select the terminal text that a
   * mouse has always been able to drag-select. A viewer act on the viewer's
   * own screen, so it renders for `view` grantees too. Swap labels follow
   * the bell pattern: the label names what pressing the item DOES.
   */
  copyMode?: { on: boolean; onToggle: () => void };
  /** When present: the menu opens on right-click of this subtree instead of
   * behind a ⋯ button — the sidebar's recent rows (spec 2026-09-03). */
  children?: ReactNode;
}): ReactNode {
  // ReactNode, not JSX.Element | null: the viewer's no-menu path returns the
  // caller's children verbatim (whatever element — or elements — they are).
  const [titleOpen, setTitleOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [switchPresetOpen, setSwitchPresetOpen] = useState(false);
  const navigate = useNavigate();
  const { data: presets } = usePresets();
  const { restart, remove, toggleNotify, busy } = useSubshellMutations(subshell.id, subshell, {
    onDeleted,
  });
  // Access drives which actions exist (spec 2026-08-31 §4.1): `view` can read
  // and watch, `edit` interacts and manages (title, restart), and only the
  // `owner` may ring the bell, clone, manage sharing, or close. A `view`
  // grantee still gets a MENU (issue 242): the viewer-side items — QR, copy
  // mode, diagnostics — act on this viewer's own screen, not on the subshell.
  // Lifecycle shrank with the Close rename (spec 2026-09-03): no Terminate
  // (Close subsumes it) and no title-pin toggle (a rename IS the pin).
  const canEdit = subshell.access !== "view";
  const isOwner = subshell.access === "owner";
  // The live-pane path is "Switch preset…" below (spec 2026-09-23), which
  // restarts the row on another preset of its harness. Editing the preset
  // DEFINITION + starting again remains the other loop for a failed launch
  // (bad key, bad flag…), and the definition item is still only offered on
  // dead subshells — a running one is past the point where editing the
  // definition does anything until it starts or swaps — and only when it
  // launched from a preset at all: a presetless launch has nothing to edit
  // (spec 2026-09-13 §8). Hidden until the name resolves, since a bare id
  // would only confuse.
  const preset = !subshell.alive ? presets?.find((p) => p.id === subshell.presetId) : undefined;
  const [qrOpen, setQrOpen] = useState(false);

  const items: ActionItem[] = [
    ...(canEdit
      ? [
          // The modal is also how a phone renames: below the tiling
          // breakpoint the header's second row shows the title as
          // display-only text (no room for an inline editor there).
          {
            icon: TextCursorInput,
            label: "Edit title",
            sidebar: true,
            onSelect: () => setTitleOpen(true),
          },
          // No note item (spec 2026-09-03 follow-up): the operator-note
          // feature was removed — dialog, endpoint, and MCP tool included.
          // No title-pin item (spec 2026-09-03): pane-title auto-naming is the
          // default and an explicit "Edit title" IS the pin — the rename locks
          // the name server-side, with no unlock path by design.
        ]
      : []),
    // Desktop only, and `isDesktop()` — the WIDE question, either shell. A
    // desktop window is a webview with no second tab, so this is how a subshell
    // gets into the browser the person actually uses; both apps grant the one
    // command it calls.
    //
    // Not gated by access, and it does not need to be (issue 242 made this
    // reachable for a `view` grantee too): it opens the SAME page the menu
    // was opened from, whose own access check the server does on arrival.
    //
    // `sidebar: true`, so the rail's right-click menu on a recent row carries
    // it too — which is where "open this one elsewhere" is most often wanted.
    ...(isDesktop()
      ? [
          {
            icon: ExternalLink,
            label: "Open in browser",
            sidebar: true,
            onSelect: () => void desktopInvoke("desktop_open_in_browser", { path: `/subshells/${subshell.id}` }),
          },
        ]
      : []),
    // Beside "Open in browser", because it is the same act with a further
    // destination — the QR carries this subshell's own path on an address the
    // instance will actually accept, which is the half a uuid in the URL bar
    // does not solve. Ungated by access for that item's reason: it opens the
    // SAME page, whose access the server checks on arrival — which is exactly
    // why it is worth showing to a `view` grantee, for whom it is how this
    // same page reaches a second screen. `sidebar: true` so the rail's
    // right-click menu carries it too.
    { icon: QrCode, label: "QR code…", sidebar: true, onSelect: () => setQrOpen(true) },
    // Page-only (see the prop's doc): toggles the pane diagnostics overlay on
    // THIS view. A toggle, not an act on the subshell, so it is checkable
    // rather than confirm- or mutation-shaped, and it is not `sidebar: true`
    // because a rail row has no terminal under it to diagnose.
    ...(diagnostics
      ? [{ icon: Activity, label: "Diagnostics", checked: diagnostics.on, onSelect: diagnostics.onToggle }]
      : []),
    // Copy mode (issue 242), the diagnostics posture again: page-and-touch
    // only (the prop's presence is the whole gate). The bell's swap-label
    // pattern — each state names what the NEXT press does — and no check
    // mark, because the two labels already are the state. Not `sidebar:
    // true`: a rail row has no terminal to put into copy mode.
    ...(copyMode
      ? [
          copyMode.on
            ? { icon: Keyboard, label: "Enable text input", onSelect: copyMode.onToggle }
            : { icon: Copy, label: "Enable text copying", onSelect: copyMode.onToggle },
        ]
      : []),
    // Owner-only: the bell decides whether THIS subshell pushes to the owner's
    // devices, so it is theirs to set regardless of who else can act on it.
    ...(isOwner
      ? [
          subshell.notify
            ? { icon: BellOff, label: "Mute notifications", sidebar: true, onSelect: () => void toggleNotify() }
            : { icon: Bell, label: "Notify when done", sidebar: true, onSelect: () => void toggleNotify() },
        ]
      : []),
    // Revive is the sidebar's remaining lifecycle gesture (spec 2026-09-03
    // amendment, shrunk by the close-vocabulary design): a live subshell has
    // no stop action — Close removes it outright, which terminates first.
    ...(canEdit && !subshell.alive
      ? [
          {
            icon: RotateCcw,
            // A tracked-but-dead subshell resumes in place; a terminated one
            // can only be started afresh from the same harness and directory,
            // which is a different enough thing to say so.
            label: subshell.status === "running" ? "Restart" : "Start again",
            sidebar: true,
            onSelect: () => void restart(),
          },
        ]
      : []),
    // Beside the plain restart, gated by the same `canEdit` — and offered on
    // live panes too, unlike restart's dead-row `!alive` condition (spec
    // 2026-09-23): a running pane is revived from the new preset, a dead one
    // is started with it. It replaces nothing; "Edit preset …" edits the
    // DEFINITION, this changes which one the row uses.
    ...(canEdit
      ? [
          {
            icon: ArrowLeftRight,
            label: "Switch preset…",
            sidebar: true,
            onSelect: () => setSwitchPresetOpen(true),
          },
        ]
      : []),
    // Owner-only, adjacent to the launch actions. Spec §2.1 said `canEdit`,
    // but a clone is guaranteed to 404 for a non-owner: the POST re-resolves
    // the SOURCE's preset under the CALLER's account and presets are
    // strictly per-user (subshells.service rejects any non-owner's presetId),
    // so an `edit` grantee can never succeed. A clone is a FRESH launch under
    // the caller's account — unlike "Start again", which revives this row.
    ...(isOwner
      ? [
          {
            icon: Copy,
            label: "Clone…",
            sidebar: true,
            onSelect: () => setCloneOpen(true),
          },
        ]
      : []),
    ...(preset
      ? [
          {
            icon: SlidersHorizontal,
            label: `Edit preset "${preset.name}"`,
            onSelect: () => void navigate({ to: "/presets/$id", params: { id: preset.id } }),
          },
        ]
      : []),
    ...(isOwner
      ? [
          { icon: Share2, label: "Share…", sidebar: true, onSelect: () => setShareOpen(true) },
          // "Close" is the DELETE verb's human name (spec 2026-09-03): it
          // terminates a running process first, then removes row + log.
          { icon: X, label: "Close", destructive: true, sidebar: true, onSelect: () => void remove() },
        ]
      : []),
  ];

  // The menu renders for EVERY access level (issue 242): the per-item gates
  // above are what enforce §4.1, and a `view` grantee has viewer-side acts —
  // QR, copy mode, diagnostics — that act on this viewer's screen rather
  // than on the subshell. An item list that came out empty is still no menu:
  // in children mode the row must show unwrapped, exactly as the viewer's
  // old always-bare path did.
  if (items.length === 0) return children ? children : null;

  return (
    <>
      <ActionsMenu label={subshell.name} items={items} disabled={disabled || busy}>
        {children}
      </ActionsMenu>

      <TitleDialog
        key={`${subshell.id}-title`}
        subshellId={subshell.id}
        currentName={subshell.name}
        open={titleOpen}
        onOpenChange={setTitleOpen}
      />
      {isOwner && <SharingDialog subshellId={subshell.id} open={shareOpen} onOpenChange={setShareOpen} />}
      {/* Mounted only while open, so every open starts from a blank name and a
          cleared POST error. TitleDialog deliberately keeps its draft across
          closes; a clone is a one-shot launch, so a stale name or error from a
          previous attempt would be a wrong prefill — remount-on-open gives the
          fresh state for free (Task 2 review). */}
      {cloneOpen && <CloneSubshellDialog source={subshell} open onOpenChange={setCloneOpen} />}
      {/* Same mount-while-open posture: every open starts from an unset
          selection and a cleared POST error. */}
      {switchPresetOpen && <SwitchPresetDialog subshell={subshell} open onOpenChange={setSwitchPresetOpen} />}
      <QrLinkDialog
        open={qrOpen}
        onOpenChange={setQrOpen}
        title={`Open "${subshell.name}" elsewhere`}
        description="Scan to open this subshell on another device. It still asks whoever scans it to sign in."
        path={`/subshells/${subshell.id}`}
      />
    </>
  );
}
