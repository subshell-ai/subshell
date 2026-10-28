/**
 * **Virtual Displays** — what this Mac needs before a subshell can run a
 * graphical app, and the one press that opens the panel where that happens.
 *
 * The screen exists because the door it replaces was only in the macOS menu
 * bar. Three places to look for one item is too many: the control plane's node
 * settings name this subject, the app menu held the only door, and a person
 * reading those settings looks in the window first. The rail puts the door
 * where they were already looking, and the screen says what the panel then asks
 * for, which the menu item never could.
 *
 * Subshell Client's `display-screen.tsx` is the same page with its own app
 * named in the menu-bar line, and its steps and notes are word-for-word this
 * screen's: one subject, two apps that can sit on one machine, and no reason
 * for a reader to learn two names for the same permission.
 *
 * **Drawn only on a Mac.** The rail section is dropped off macOS
 * (`server-state.ts`'s `railFor`), because the helper is BetterDisplay's and a
 * Linux host has nothing for the panel to be.
 *
 * **The press opens a window and reports nothing back, on purpose.** Enabling
 * the helper and granting macOS its two permissions all happen in another
 * program's windows, so there is no status to poll here; a spinner waiting on a
 * panel that is already open would misreport what the press is still doing. A
 * refusal to open is rare, and `desktop_open_display_helper` answers it in a
 * native dialog where the person is looking.
 */
import { type AssistantStrings, Frame } from "@internal/assistant";
import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import type { Probe } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import { leaveLabel } from "../lib/wizard-state";

/** The three things the panel and macOS ask for, in the order they happen. */
const STEPS: readonly string[] = [
  "Choose Enable helper. It keeps running after you close Subshell Server. Starting it at sign-in is a separate choice under Launch at sign-in and may need macOS approval.",
  "Grant Screen Recording and Accessibility to Subshell Display Helper in System Settings. Screen Recording lets it capture the virtual screen, and Accessibility lets it send keyboard and pointer input.",
  "If macOS asks you to restart the helper, choose Quit helper from its menu bar icon, then reopen Display Helper settings here. You won't need to enable it again.",
];

export function DisplayScreen(props: {
  /** The rail node the host computed for this route, or undefined when the route is full-window. */
  rail?: ReactElement;
  strings: AssistantStrings;
  entranceKey?: number;
  probe: Probe;
  onClose: () => void;
}): ReactElement {
  const { probe } = props;

  return (
    <Frame
      rail={props.rail}
      strings={props.strings}
      entranceKey={props.entranceKey}
      barLeft={
        // The rail is the navigation, so a leave button beside it answers a
        // question the rail already answers. It stays ONLY where the rail is
        // not: a requested screen over a machine that is not onboarded renders
        // without one, and there this is the only way out.
        props.rail === undefined && (
          <Button type="button" variant="ghost" onClick={props.onClose}>
            {leaveLabel(probe, probe.onboarded)}
          </Button>
        )
      }
      barRight={
        <Button
          className="min-w-[120px]"
          onClick={() => {
            // Rust answers a refusal in a native dialog, so there is nothing
            // for this screen to say about one.
            void ipc.openDisplayHelper().catch(() => {});
          }}
        >
          Open Display Helper settings
        </Button>
      }
    >
      <p className="text-muted-foreground text-sm leading-relaxed">
        The helper starts disabled when this app installs it. To let anyone view or control a virtual display, enable it
        in its settings and grant both macOS permissions.
      </p>
      <ol className="mt-6 flex flex-col gap-3">
        {STEPS.map((step, index) => (
          <li key={step} className="flex gap-3">
            <span aria-hidden className="text-muted-foreground text-label font-strong shrink-0 tabular-nums">
              {index + 1}
            </span>
            <span className="text-sm leading-relaxed">{step}</span>
          </li>
        ))}
      </ol>
      <p className="text-muted-foreground text-detail leading-relaxed mt-6">
        Requires macOS 14 or later. Virtual displays use your current Mac login and share its keyboard focus and
        pointer. Viewers may see other windows on the display and can control this Mac, so enable the helper only for
        people you trust.
      </p>
      <p className="text-muted-foreground text-detail leading-relaxed mt-2">
        The helper runs as <span className="font-strong">Subshell Display Helper</span> and has its own display icon in
        the macOS menu bar. Use that menu to open its settings or disable the helper at any time. <GuideLink /> explains
        the setup, including what BetterDisplay needs.
      </p>
    </Frame>
  );
}

/**
 * The one link this screen offers, carrying the word the command knows. An
 * ordinary `<a>` would open inside the webview under the bundle's CSP, so the
 * press names a member of Rust's closed set and the SYSTEM browser opens it.
 */
function GuideLink(): ReactElement {
  return (
    <button
      type="button"
      className="rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      onClick={() => {
        // A refused open costs a convenience, not a step: the three above are
        // the same ground the guide covers.
        void ipc.openWeb("display-guide").catch(() => {});
      }}
    >
      How to enable the display helper
    </button>
  );
}
