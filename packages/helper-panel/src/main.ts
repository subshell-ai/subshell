import "./styles.css";
import { EMPTY_STATE, type PanelAction, type PanelMessage, type PanelState } from "./state";
import { loginItemLine, permissionValue, type StateValue, stateLine, strings, viewerLine } from "./strings";

/** The bridge the Swift side installs. Absent in a browser, which is how the
 *  page stays previewable while every real act needs the helper process. */
interface PanelBridge {
  postMessage(message: PanelMessage): void;
}
declare global {
  interface Window {
    subshellSetState?: (state: PanelState) => void;
    webkit?: { messageHandlers?: { subshell?: PanelBridge } };
  }
}

/** Which of the assistant's button looks to wear, in plain CSS. Only these
 *  two exist on purpose: a control that does something wears a shape, the one
 *  primary wears the gradient, and nothing in the card is a bare hover-wash
 *  that reads as a link. */
type Variant = "primary" | "outline";

function bridge(): PanelBridge | undefined {
  return window.webkit?.messageHandlers?.subshell;
}

function element<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className: string,
  content?: string,
): HTMLElementTagNameMap[Tag] {
  const el = document.createElement(tag);
  el.className = className;
  if (content !== undefined) el.textContent = content;
  return el;
}

function button(label: string, action: PanelAction, variant: Variant = "outline"): HTMLButtonElement {
  const el = element("button", `btn btn-${variant}`);
  el.type = "button";
  el.textContent = label;
  el.addEventListener("click", () => bridge()?.postMessage({ action }));
  return el;
}

/**
 * A section heading with the trailing rule: the assistant's `FormSectionTitle`.
 * That rule is the only divider a section brings, so grouping reads as heading
 * and spacing rather than as a stack of hairlines.
 */
function sectionTitle(label: string): HTMLElement {
  const heading = element("h2", "section-title");
  const rule = element("span", "section-rule");
  rule.setAttribute("aria-hidden", "true");
  heading.append(element("span", "section-caption", label), rule);
  return heading;
}

function section(label: string, children: Node[]): HTMLElement {
  const el = element("section", "section");
  el.append(sectionTitle(label), ...children);
  return el;
}

/** The state word on its own, coloured by whether it still needs the person. */
function valueSpan(value: StateValue): HTMLElement {
  return element("span", `value${value.blocked ? " value-blocked" : " value-ok"}`, value.text);
}

/**
 * A settings row: the label and its state word together on the left, the one
 * control that changes them on the right. A control is optional because a
 * settled fact has nothing left to ask for, and the button never wraps its own
 * label, so a long sentence and a short control share the row honestly instead
 * of fighting for the same pixels.
 */
function row(parts: { status?: string; value?: StateValue; control?: HTMLElement }): HTMLElement {
  const el = element("div", "row");
  if (parts.status !== undefined) el.append(element("span", "status", `${parts.status}:`));
  if (parts.value) el.append(valueSpan(parts.value));
  if (parts.control) el.append(parts.control);
  return el;
}

/**
 * A permission row. The buttons are `disabled` rather than hidden while consent
 * is off, with the reason as the title, because a control that is not there
 * cannot be explained. The helper refuses these requests as well, so a page
 * that somehow fires one still gets a refusal instead of a prompt.
 */
function permissionRow(label: string, granted: boolean, askLabel: string, action: PanelAction, consented: boolean) {
  let ask: HTMLButtonElement | undefined;
  // Granted, there is nothing left to ask macOS for: the row states the fact
  // and offers no control. A button that opens a prompt which cannot appear is
  // worse than none, because pressing it and seeing nothing looks like a hang.
  if (!granted) {
    ask = button(strings.allow, action, "outline");
    ask.setAttribute("aria-label", askLabel);
    ask.disabled = !consented;
    if (!consented) ask.title = strings.permissionNeedsConsent;
  }
  return row({ status: label, value: permissionValue(granted), control: ask });
}

function render(state: PanelState): void {
  const root = document.getElementById("panel");
  if (!root) return;
  root.replaceChildren();

  const content = element("div", "content");
  const header = element("header", "head");
  header.append(element("h1", "title", strings.title), element("p", "subtitle", strings.subtitle));
  content.append(header);

  // The refusal goes above the card, the way the assistant's frame puts its
  // problem line under the subtitle: it is why the screen still looks like
  // this, so it has to be read before the button that failed is pressed again.
  // role=alert announces it while the panel is open; it is the only live
  // region, because the whole card is rebuilt on every push.
  if (state.error) {
    const err = element("p", "error", state.error);
    err.setAttribute("role", "alert");
    content.append(err);
  }

  // The warning sits above the button it warns about, not under it where a
  // person has already pressed the thing.
  const toggle = button(
    state.enabled ? strings.disable : strings.enable,
    state.enabled ? "disable" : "enable",
    "primary",
  );
  const note = element("p", "note", strings.enableNote);
  note.id = "enable-note";
  toggle.setAttribute("aria-describedby", "enable-note");
  content.append(
    section(strings.access, [
      element("p", "state", stateLine(state)),
      element("p", state.viewers > 0 ? "viewers is-live" : "viewers", viewerLine(state)),
      element("p", "warning", strings.warning),
      toggle,
      note,
    ]),
  );

  // macOS only lists the login item once the helper registers it, so the whole
  // section appears with the consent that created it. While the helper is off
  // there is nothing registered to approve, and a heading over an empty row is
  // how a panel starts lying about itself.
  if (state.enabled) {
    content.append(
      section(strings.signInSection, [
        row({
          value: loginItemLine(state.loginItemNeedsApproval),
          control: button(strings.openLoginItems, "openLoginItems", "outline"),
        }),
      ]),
    );
  }

  content.append(
    section(strings.permissions, [
      permissionRow("Screen Recording", state.screenRecording, strings.requestCapture, "requestCapture", state.enabled),
      permissionRow("Accessibility", state.accessibility, strings.requestInput, "requestInput", state.enabled),
    ]),
  );

  // macOS puts a window's help at the bottom left and its exits at the bottom
  // right, so that is where they go. What they may NOT do is wear different
  // shapes: this row once mixed a plum text link with two buttons that have no
  // outline until you hover them, and it read as three unrelated things that
  // had wandered in from other screens. The primary stays in the card with the
  // state it changes and the warning that says what it costs.
  const bar = element("footer", "bar");
  const help = element("div", "bar-side");
  help.append(button(strings.openDocs, "openDocs"));
  const exits = element("div", "bar-side bar-exits");
  exits.append(button(strings.minimize, "minimize"), button(strings.quit, "quit"));
  bar.append(help, exits);

  root.append(content, bar);

  // The Swift window sizes to the content, so the page reports what it needs.
  // The Swift window sizes to the document, so the page reports both of its
  // own dimensions rather than the window guessing and the content scrolling.
  const box = root.getBoundingClientRect();
  bridge()?.postMessage({ action: "resize", width: Math.ceil(box.width), height: Math.ceil(box.height) });
}

let current: PanelState = EMPTY_STATE;

/** Called by the helper after every change: consent, a permission grant, a
 *  viewer arriving or leaving, a refusal. The page keeps no state of its own,
 *  so a missed push is impossible: the last one wins. */
window.subshellSetState = (state: PanelState) => {
  current = { ...EMPTY_STATE, ...state };
  render(current);
};

render(current);
