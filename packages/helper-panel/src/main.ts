import "./styles.css";
import { EMPTY_STATE, type PanelAction, type PanelMessage, type PanelState, type StateValue } from "./state";
import {
  consentControl,
  loginItemLine,
  permissionValue,
  quitBody,
  showsSignInSection,
  stateLine,
  strings,
  viewerLine,
} from "./strings";

/** The bridge the Swift side installs. Absent in a browser, which is how the
 *  page stays previewable while every real act needs the helper process. */
interface PanelBridge {
  postMessage(message: PanelMessage): void;
}
declare global {
  interface Window {
    subshellPanelShown?: () => void;
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
interface PermissionRowParts {
  /** The permission, as the row's label. */
  label: string;
  /** macOS's answer, which decides which control the row gets. */
  granted: boolean;
  /** The helper's own consent, which gates the prompt. */
  consented: boolean;
  /** The request to make while macOS has not answered. */
  ask: { label: string; action: PanelAction };
  /** The pane to open once it has: the prompt has nothing left to say. */
  review: { label: string; action: PanelAction };
  /** The gold line explaining why the control is off. */
  reasonId: string;
}

function permissionRow(parts: PermissionRowParts) {
  // Every row carries a control, because the row that reads "Allowed" is also
  // the row a person may want to go and check. What it may not do is offer the
  // prompt again once macOS has answered it: that press would do nothing, and
  // a button that does nothing reads as a hang.
  const granted = parts.granted;
  const control = granted
    ? button(strings.openSettings, parts.review.action, "outline")
    : button(strings.allow, parts.ask.action, "outline");
  control.setAttribute("aria-label", granted ? parts.review.label : parts.ask.label);
  if (!granted) {
    control.disabled = !parts.consented;
    if (!parts.consented) control.setAttribute("aria-describedby", parts.reasonId);
  }
  return row(parts.label, permissionValue(granted), control);
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
function quitDialog(state: PanelState): HTMLElement {
  const scrim = element("div", "scrim");
  const dialog = element("div", "dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "quit-title");
  dialog.setAttribute("aria-describedby", "quit-body");
  const title = element("h2", "dialog-title", strings.quitTitle);
  title.id = "quit-title";
  const body = element("p", "dialog-body", quitBody(state.loginItem, state.enabled));
  body.id = "quit-body";
  const foot = element("div", "dialog-foot");
  const cancel = pageButton(strings.cancel, "outline", closeQuitDialog);
  const confirm = pageButton(strings.quit, "destructive", () => {
    closeQuitDialog();
    bridge()?.postMessage({ action: "quit" });
  });
  foot.append(cancel, confirm);
  dialog.append(title, body, foot);
  scrim.append(dialog);
  // Focus the way out, not the act. `aria-modal` is a promise the background
  // cannot be reached, and the scrim has no inert attribute to enforce it, so
  // Tab is kept inside the two controls here rather than left to the browser.
  scrim.tabIndex = -1;
  scrim.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const controls = [cancel, confirm];
    const at = controls.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.shiftKey ? -1 : 1;
    const next = (at + step + controls.length) % controls.length;
    event.preventDefault();
    controls[next]?.focus();
  });
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
  const existingDialog = confirmingQuit ? root.querySelector<HTMLElement>(".scrim") : null;
  const focused = existingDialog?.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
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
  // One call decides the button and the sentence under it, because the defect
  // this replaces was a pair of ternaries reading the same state separately: the
  // control said "Enable helper" while its own note described disabling, and a
  // person deciding whether this Mac may be captured had that announcement to
  // decide from.
  const consent = consentControl(state);
  const toggle = button(consent.label, consent.action, "primary");
  const note = element("p", "note", consent.note);
  // One id for both states, named for what it is: it describes the consent act
  // on offer, which flips with the button. "enable-note" read as a leftover the
  // moment the button said "Disable helper", which is how a second describedby
  // gets wired to the wrong half.
  note.id = "consent-note";
  toggle.setAttribute("aria-describedby", "consent-note");
  content.append(
    section(strings.access, [
      element("p", "state", stateLine(state)),
      element("p", state.viewers > 0 ? "viewers is-live" : "viewers", viewerLine(state)),
      element("p", "warning", strings.warning),
      toggle,
      note,
    ]),
  );

  // The section appears with the consent that usually created a registration,
  // and stays for a registration that outlived it: disabling leaves the person's
  // sign-in choice alone, and this row is the only way to take it back.
  if (showsSignInSection(state)) {
    content.append(
      section(strings.signInSection, [
        // One control, named for the state it is leaving: register, stop
        // registering, or go to the setting macOS is waiting on. None of them
        // happen by themselves when the helper is enabled.
        row(
          strings.loginItemLabel,
          loginItemLine(state.loginItem),
          state.loginItem === "registered"
            ? button(strings.stopAtSignIn, "unregisterLoginItem")
            : state.loginItem === "notRegistered"
              ? button(strings.startAtSignIn, "registerLoginItem")
              : button(strings.openLoginItems, "openLoginItems"),
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
      permissionRow({
        label: strings.capturePermissionLabel,
        granted: state.screenRecording,
        consented: state.enabled,
        ask: { label: strings.requestCapture, action: "requestCapture" },
        review: { label: strings.openCaptureSettingsLabel, action: "openCaptureSettings" },
        reasonId: blockedId,
      }),
      permissionRow({
        label: strings.inputPermissionLabel,
        granted: state.accessibility,
        consented: state.enabled,
        ask: { label: strings.requestInput, action: "requestInput" },
        review: { label: strings.openInputSettingsLabel, action: "openInputSettings" },
        reasonId: blockedId,
      }),
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
  if (confirmingQuit) {
    const dialog = existingDialog ?? quitDialog(state);
    const body = dialog.querySelector("#quit-body");
    if (body) body.textContent = quitBody(state.loginItem, state.enabled);
    root.append(dialog);
    focused?.focus();
  }

  // The Swift window sizes to the document, so the page reports both of its
  // own dimensions rather than the window guessing and the content scrolling.
  const box = root.getBoundingClientRect();
  bridge()?.postMessage({
    action: "resize",
    width: Math.ceil(Number.isFinite(box.width) ? box.width : 0),
    height: Math.ceil(Number.isFinite(box.height) ? box.height : 0),
  });
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

// AppKit keeps the document alive when the settings window closes.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && confirmingQuit) closeQuitDialog();
});

// AppKit explicitly signals reopening; WebKit visibility events alone aren't
// reliable when a retained native window is hidden rather than unloaded.
window.subshellPanelShown = () => {
  if (confirmingQuit) closeQuitDialog();
};
