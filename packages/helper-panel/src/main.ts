import "./styles.css";
import { EMPTY_STATE, type PanelAction, type PanelMessage, type PanelState, type StateValue } from "./state";
import { loginItemLine, permissionValue, stateLine, strings, viewerLine } from "./strings";

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

/** Which of the assistant's button looks to wear, in plain CSS. Only these two
 *  exist on purpose: a control that does something wears a shape, the one
 *  primary wears the gradient, and nothing is a bare hover-wash that reads as a
 *  link. */
type Variant = "primary" | "outline" | "destructive";

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

function makeButton(label: string, variant: Variant): HTMLButtonElement {
  const el = element("button", `btn btn-${variant}`);
  el.type = "button";
  el.textContent = label;
  return el;
}

/** A control that asks the helper to do something. */
function button(label: string, action: PanelAction, variant: Variant = "outline"): HTMLButtonElement {
  const el = makeButton(label, variant);
  el.addEventListener("click", () => bridge()?.postMessage({ action }));
  return el;
}

/** A control that does something in the page instead, like opening a dialog. */
function pageButton(label: string, variant: Variant, onClick: () => void): HTMLButtonElement {
  const el = makeButton(label, variant);
  el.addEventListener("click", onClick);
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

/**
 * One labelled fact, in the dashboard's own shape: a strong muted `detail`
 * label above a regular `body` value, weight, size, and colour distinguishing
 * them together because muted colour alone is not enough to tell them apart.
 */
function fact(label: string, value: StateValue): HTMLElement {
  const pair = element("div", "fact");
  pair.append(
    element("dt", "fact-label", label),
    element("dd", `fact-value${value.blocked ? " is-blocked" : ""}`, value.text),
  );
  return pair;
}

/**
 * A fact and the one control that changes it. The value is gold when the
 * person still has something to do and the page's own ink when it is settled,
 * which is how the row tells "waiting on you" from "already true" at a glance.
 */
function row(label: string, value: StateValue, control?: HTMLElement): HTMLElement {
  const el = element("dl", "row");
  el.append(fact(label, value));
  if (control) el.append(control);
  return el;
}

/**
 * A permission row. While consent is off the buttons are `disabled` rather than
 * hidden, because a control that is not there cannot be explained, and the
 * reason is drawn inline in gold and named by aria-describedby: a native title
 * is invisible to a person on touch who cannot hover, and unreliable for a
 * screen reader. The helper refuses these requests as well, so a page that
 * somehow fires one still gets a refusal instead of a prompt.
 */
function permissionRow(
  label: string,
  granted: boolean,
  askLabel: string,
  action: PanelAction,
  consented: boolean,
  reasonId: string,
) {
  let ask: HTMLButtonElement | undefined;
  // Granted, there is nothing left to ask macOS for: the row states the fact
  // and offers no control. A button that opens a prompt which cannot appear is
  // worse than none, because pressing it and seeing nothing looks like a hang.
  if (!granted) {
    ask = button(strings.allow, action, "outline");
    ask.setAttribute("aria-label", askLabel);
    ask.disabled = !consented;
    if (!consented) ask.setAttribute("aria-describedby", reasonId);
  }
  return row(label, permissionValue(granted), ask);
}

/**
 * Whether the quit confirmation is up. Page-local and transient on purpose:
 * it is not a fact about the machine, and the helper never reads it. It
 * survives a state push because `render` draws it from here.
 */
let confirmingQuit = false;

function closeQuitDialog(): void {
  confirmingQuit = false;
  render(current);
}

/**
 * The confirmation for the one act in this panel that is not reversible from
 * the window itself: quitting. The title asks and names the action; the body
 * says what stops, what stays, and how to get back, which is the part a silent
 * quit never told anyone. Cancel is focused, and Escape dismisses, because the
 * safe answer must be the easy one.
 */
function quitDialog(): HTMLElement {
  const scrim = element("div", "scrim");
  const dialog = element("div", "dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "quit-title");
  dialog.setAttribute("aria-describedby", "quit-body");
  const title = element("h2", "dialog-title", strings.quitTitle);
  title.id = "quit-title";
  const body = element("p", "dialog-body", strings.quitBody);
  body.id = "quit-body";
  const foot = element("div", "dialog-foot");
  const cancel = pageButton(strings.cancel, "outline", closeQuitDialog);
  const confirm = pageButton(strings.quit, "destructive", () => bridge()?.postMessage({ action: "quit" }));
  foot.append(cancel, confirm);
  dialog.append(title, body, foot);
  scrim.append(dialog);
  // Focus the way out, not the act.
  queueMicrotask(() => cancel.focus());
  return scrim;
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && confirmingQuit) {
    event.preventDefault();
    closeQuitDialog();
  }
});

function render(state: PanelState): void {
  const root = document.getElementById("panel");
  if (!root) return;
  root.replaceChildren();

  const card = element("section", "card");
  const header = element("header", "head");
  header.append(element("h1", "title", strings.title), element("p", "subtitle", strings.subtitle));
  card.append(header);

  // role=alert so a refusal that arrives while the panel is open is announced,
  // not just painted red. Above the controls, because it is why the screen
  // still looks like this and has to be read before the failed button is
  // pressed again.
  if (state.error) {
    const err = element("p", "error", state.error);
    err.setAttribute("role", "alert");
    card.append(err);
  }

  const content = element("div", "content");

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
        row(
          strings.loginItemLabel,
          loginItemLine(state.loginItemNeedsApproval),
          button(strings.openLoginItems, "openLoginItems"),
        ),
      ]),
    );
  }

  // One reason for both disabled buttons, drawn once in gold under the heading
  // and named by each control's aria-describedby.
  const blockedId = "permission-blocked";
  const reason = element("p", "blocked-reason", strings.permissionNeedsConsent);
  reason.id = blockedId;
  content.append(
    section(strings.permissions, [
      ...(state.enabled ? [] : [reason]),
      permissionRow(
        "Screen recording",
        state.screenRecording,
        strings.requestCapture,
        "requestCapture",
        state.enabled,
        blockedId,
      ),
      permissionRow(
        "Accessibility",
        state.accessibility,
        strings.requestInput,
        "requestInput",
        state.enabled,
        blockedId,
      ),
    ]),
  );

  card.append(content);

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
  // The bar's Quit opens the confirmation; only the dialog's Confirm posts
  // `quit`, so the act still belongs to the helper and the page only asks.
  const askQuit = pageButton(strings.quit, "outline", () => {
    confirmingQuit = true;
    render(current);
  });
  exits.append(button(strings.minimize, "minimize"), askQuit);
  bar.append(help, exits);
  card.append(bar);

  root.append(card);
  if (confirmingQuit) root.append(quitDialog());

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
