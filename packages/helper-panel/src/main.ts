import "./styles.css";
import { EMPTY_STATE, type PanelAction, type PanelState } from "./state";
import { permissionLine, stateLine, strings, viewerLine } from "./strings";

/** The bridge the Swift side installs. Absent in a browser, which is how the
 *  page stays previewable while every real act needs the helper process. */
interface PanelBridge {
  postMessage(message: { action: PanelAction } | { action: "resize"; height: number }): void;
}
declare global {
  interface Window {
    subshellSetState?: (state: PanelState) => void;
    webkit?: { messageHandlers?: { subshell?: PanelBridge } };
  }
}

function bridge(): PanelBridge | undefined {
  return window.webkit?.messageHandlers?.subshell;
}

function button(label: string, action: PanelAction, primary = false): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = label;
  el.className = primary ? "btn btn-primary" : "btn";
  el.addEventListener("click", () => bridge()?.postMessage({ action }));
  return el;
}

/** A paragraph-class element with the right tag for its role. */
function line(tag: "p" | "h1" | "span", className: string, content: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = content;
  return el;
}

/** A section heading with the trailing rule: the assistant's `FormSectionTitle` shape. */
function sectionTitle(label: string): HTMLElement {
  const heading = document.createElement("h2");
  heading.className = "section-title";
  const caption = document.createElement("span");
  caption.textContent = label;
  const rule = document.createElement("span");
  rule.setAttribute("aria-hidden", "true");
  rule.className = "section-rule";
  heading.append(caption, rule);
  return heading;
}

/**
 * A permission row: the machine's answer on the left, the request on the
 * right. The buttons are `disabled` rather than hidden while consent is off,
 * with the reason as the title, because a control that is not there cannot be
 * explained. The helper refuses these requests as well, so a page that
 * somehow fires one still gets a refusal instead of a prompt.
 */
function permissionRow(label: string, granted: boolean, requestLabel: string, action: PanelAction, consented: boolean) {
  const row = document.createElement("div");
  row.className = "row";
  const status = line("span", "detail", permissionLine(label, granted));
  const btn = button(requestLabel, action);
  btn.disabled = !consented;
  if (!consented) btn.title = strings.permissionNeedsConsent;
  row.append(status, btn);
  return row;
}

function render(state: PanelState): void {
  const root = document.getElementById("panel");
  if (!root) return;
  root.replaceChildren();

  const head = document.createElement("header");
  head.className = "head";
  head.append(line("h1", "title", strings.title), line("span", "detail", strings.subtitle));
  root.append(head);

  root.append(line("p", "warning", strings.warning));

  const access = document.createElement("section");
  access.className = "section";
  access.append(
    sectionTitle(strings.access),
    line("p", "body", stateLine(state)),
    line("p", state.viewers > 0 ? "viewers-live" : "viewers", viewerLine(state)),
    button(state.enabled ? strings.disable : strings.enable, state.enabled ? "disable" : "enable", true),
    line("p", "detail", strings.enableNote),
  );
  const login = button(strings.openLoginItems, "openLoginItems");
  login.classList.add("alone");
  access.append(login);
  root.append(access);

  const permissions = document.createElement("section");
  permissions.className = "section";
  permissions.append(
    sectionTitle(strings.permissions),
    permissionRow("Screen Recording", state.screenRecording, strings.requestCapture, "requestCapture", state.enabled),
    permissionRow("Accessibility", state.accessibility, strings.requestInput, "requestInput", state.enabled),
  );
  root.append(permissions);

  // role=alert so a refusal that arrives while the panel is open is announced,
  // not just painted red.
  if (state.error) {
    const err = line("p", "error", state.error);
    err.setAttribute("role", "alert");
    root.append(err);
  }

  const foot = document.createElement("footer");
  foot.className = "foot";
  const right = document.createElement("div");
  right.className = "foot-right";
  right.append(button(strings.minimize, "minimize"), button(strings.quit, "quit"));
  foot.append(button(strings.openDocs, "openDocs"), right);
  root.append(foot);

  // The Swift window sizes to the content, so the page reports what it needs.
  bridge()?.postMessage({ action: "resize", height: Math.ceil(root.getBoundingClientRect().height) });
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
