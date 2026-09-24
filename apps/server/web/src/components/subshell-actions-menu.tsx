import { useNavigate } from "@tanstack/react-router";
import {
  Activity,
  ArrowLeftRight,
  Bell,
  BellOff,
  Copy,
  ExternalLink,
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
  // and watch only (so the menu itself is absent), `edit` interacts and manages
  // (title, restart), and only the `owner` may ring the bell, clone,
  // manage sharing, or close. A viewer has nothing to do here.
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
    // It is not gated beyond the menu's own `canEdit`, and it does not need to
    // be: it opens the SAME page the menu was opened from, whose own access
    // check the server does on arrival. A `view` grantee has no menu at all.
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
    // does not solve. Ungated beyond the menu's `canEdit` for that item's
    // reason: it opens the SAME page, whose access the server checks on
    // arrival, and a `view` grantee has no menu at all. `sidebar: true` so the
    // rail's right-click menu carries it too.
    { icon: QrCode, label: "QR code…", sidebar: true, onSelect: () => setQrOpen(true) },
    // Page-only (see the prop's doc): toggles the pane diagnostics overlay on
    // THIS view. A toggle, not an act on the subshell, so it is checkable
    // rather than confirm- or mutation-shaped, and it is not `sidebar: true`
    // because a rail row has no terminal under it to diagnose.
    ...(diagnostics
      ? [{ icon: Activity, label: "Diagnostics", checked: diagnostics.on, onSelect: diagnostics.onToggle }]
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

  // A viewer gets no actions menu at all — they watch the subshell (read-only
  // terminal) and that is the whole of it. In children mode "no menu" must
  // still show the row itself, so the children pass through unwrapped.
  if (!canEdit) return children ? children : null;

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
