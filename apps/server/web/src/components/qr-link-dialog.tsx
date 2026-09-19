import type { JSX } from "react";
import { AddressQr } from "@/components/address-qr";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * One thing on this instance, as a QR code — a subshell, a workspace
 * (operator's request, 2026-09-19).
 *
 * The point is getting off the machine you are sitting at. A subshell's URL is
 * a uuid nobody retypes, and the address half is worse: the origin this
 * browser is on is very often `localhost`, which the phone in your hand cannot
 * reach. So the picker offers every address the instance accepts a sign-in
 * from, exactly as the mobile install dialog does, and the QR carries the
 * chosen one with this thing's path on the end.
 *
 * **Deliberately NOT the install dialog.** That one also teaches the PWA
 * gesture — Share → Add to Home Screen, ⋮ → Install — which belongs to
 * "put Subshell on your phone" and would be noise on "open this subshell over
 * there". Someone who wants the app installed opens the rail's own row. Both
 * surfaces share `AddressQr`, so the picker, the refusal and the plate cannot
 * drift apart.
 *
 * It grants nothing. The link is the same URL the person already has open,
 * and whoever scans it still meets the sign-in page and this subshell's own
 * sharing rules — a QR is a convenience for reaching a thing, never a way to
 * hand it to somebody.
 */
export function QrLinkDialog({
  open,
  onOpenChange,
  title,
  description,
  path,
  origin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dialog title — the caller names the thing ("Open this subshell"). */
  title: string;
  /** One line under it, saying what scanning does. */
  description: string;
  /** This thing's path, `/subshells/<id>` or `/workspaces/<id>`. */
  path: string;
  /** Test seam, passed straight through — see {@link AddressQr}. */
  origin?: string;
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <AddressQr active={open} path={path} origin={origin} />
      </DialogContent>
    </Dialog>
  );
}
