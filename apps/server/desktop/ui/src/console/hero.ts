/**
 * The Overview hero: what this machine's server IS, in three lines.
 *
 * It replaces a 14px status chip and the two fact rows that answered the same
 * questions (`server cli`, `control plane URL`). Those rows sat in a list of
 * nine, in the same type as the tmux path — so the three things a person opens
 * this window for (is it up, where is it, let me in) had the weight of a
 * diagnostic. The facts list below is for when the answer is "no".
 */
import { heroState } from "../lib/console-nav";
import { el, state } from "./state";

export function renderHero(): void {
  const { word, tone } = heroState(state.probe, state.busy);
  el("hero-dot").className = `hero-dot bg-${tone === "ok" ? "ok" : tone === "warn" ? "warn" : "muted"}`;
  el("hero-state").textContent = word;

  // The version line names the program, because "0.2.0" alone in 15px under a
  // state word is a number with no subject.
  //
  // With no server there is no line at all: the state word IS "No server
  // found", and a second line saying "No subshell-server found" under it is
  // the same sentence twice in two type sizes. The step below says what to do
  // about it, which is the part that is not yet on screen.
  const server = state.probe?.server ?? null;
  const serverLine = el("hero-server");
  serverLine.textContent = server === null ? "" : `subshell-server ${server.version ?? "unknown version"}`;
  serverLine.hidden = server === null;

  // The address OTHER machines use. Shown, not opened: `desktop_open_control_plane`
  // is gone (spec 2026-09-12 § 5.6), and the dashboard's own Service page is
  // where a LAN address is now both displayed and copyable.
  const url = state.probe?.status?.settings?.APP_BASE_URL?.value ?? "";
  const row = el("hero-url");
  row.textContent = "";
  row.hidden = url === "";
  if (url === "") return;
  const address = document.createElement("span");
  address.textContent = url;
  row.append(address);
}
