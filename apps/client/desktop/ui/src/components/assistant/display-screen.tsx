/**
 * **Virtual Displays** — what this Mac needs before a subshell can run a
 * graphical app, and the one press that opens the panel where that happens.
 *
 * It exists because the panel it opens lives in the macOS menu bar, and three
 * places to look for one item is too many: the control plane's node settings
 * name this screen's subject, the app menu holds the only door, and a person
 * reading the settings page reasonably looks in the window instead. The rail
 * puts the door where they were already looking, and the screen says what to do
 * once the panel is open, which the menu item never could.
 *
 * The screen is drawn only on macOS (`client-flow.ts`'s `railFor` drops the
 * section everywhere else), so nothing here has to branch on the platform.
 *
 * **The press opens a window and reports nothing back, on purpose.** Enabling
 * the helper, and macOS granting screen recording and accessibility, all happen
 * in another program's windows and answer to that program, not to this one:
 * there is no status here to poll, and a spinner waiting on a panel that is
 * already open would be a lie about what the press is still doing. A refusal to
 * open at all is rare, and `node_open_display_helper` puts it in a native
 * dialog where the person is looking. That is also why the press calls
 * {@link nodeOpenDisplayHelper} itself rather than routing through
 * `useNodeCommands`: that hook is the set of acts that change this machine and
 * confirm first, and this changes nothing.
 */
import { Monitor } from "lucide-react";
import type { ReactElement } from "react";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { Button } from "@/components/ui/button";
import { nodeOpenDisplayHelper, nodeOpenWeb } from "@/lib/ipc";

/** The three things the panel and macOS ask for, in the order they happen. */
const STEPS: readonly string[] = [
  "Choose Enable helper. It keeps running after you close Subshell Client. Starting it at sign-in is a separate choice under Launch at sign-in and may need macOS approval.",
  "Grant Screen Recording and Accessibility to Subshell Display Helper in System Settings. Screen Recording lets it capture the virtual screen, and Accessibility lets it send keyboard and pointer input.",
  "If macOS asks you to restart the helper, choose Quit helper from its menu bar icon, then reopen Display Helper settings here. You won't need to enable it again.",
];

export function DisplayScreen(props: {
  shell: FrameShell;
  /** The rail node the app computed for this screen, or undefined when the screen is full-window. */
  rail?: ReactElement;
}): ReactElement {
  return (
    <Frame
      {...props.shell}
      rail={props.rail}
      icon={<Monitor />}
      barRight={
        <Button
          className="min-w-[120px]"
          onClick={() => {
            // Rust answers a refusal in a native dialog, so there is nothing
            // for this screen to say about one.
            void nodeOpenDisplayHelper().catch(() => {});
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
        void nodeOpenWeb("display-guide").catch(() => {});
      }}
    >
      How to enable the display helper
    </button>
  );
}
