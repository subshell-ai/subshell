/**
 * **Server Addresses** — the assistant's own editor for the four values that
 * decide whether this server is reachable at all (spec 2026-09-18 § 14).
 *
 * It exists because of one lockout, and the lockout is structural rather than
 * unlucky. Saving an `https://` base URL signs THIS APP's window out for good:
 * better-auth marks the session cookie `Secure` for an https `APP_BASE_URL`
 * (measured, 1.7.1), and the `main` window is OPENED on
 * `http://127.0.0.1:<port>`, so it can never store a session again. The value that caused it could only
 * be changed from the dashboard, which needs the session that was just lost,
 * so the app had no way back from inside itself.
 *
 * The assistant is the way out for a structural reason too: it is the BUNDLED
 * page, it drives the CLI rather than the API, and it therefore needs no
 * session. It is the same rule this app already follows — *if the act leaves
 * the server unreachable, it cannot be driven from a page the server serves* —
 * read in the other direction.
 *
 * **It is not a second Networking page.** Network plugins, the trusted-origin
 * registry and everything else stay in the dashboard; this is the four values
 * that can strand someone.
 *
 * Pure, and therefore tested without a webview — which in this app is not a
 * preference but the only option: `ui/src/__tests__/` has no DOM harness, so a
 * judgment left in `wizard.ts` is a judgment with no coverage at all.
 */
import { type AddressForm, CONFIG_FIELDS, configPayload, effectiveForm } from "./config-form";
import type { InitPayload, Probe } from "./ipc";
import { type PaneForce, paneForceBox } from "./pane-force";

/**
 * The screen's name, and the name of every door into it.
 *
 * One string, for the reason `RESET_LABEL` is one string: a link and the screen
 * it opens disagreeing about what they are for is its own small betrayal. The
 * tray's item carries it too, in Rust, which `settings-screen.test.ts` pins
 * against `tray.rs`.
 *
 * Deliberately NOT "Server Settings", which is the macOS View menu's ⌘4 into
 * the dashboard's own settings routes — a page that needs a session, i.e. the
 * exact thing a person here may not have. Two doors with one name leading to
 * two places, one of which is the trap the other repairs, is worse than a
 * narrower name.
 */
export const SETTINGS_LABEL = "Server Addresses";

/** The frame's subtitle: what these four values decide. */
export const SETTINGS_SUBTITLE = "Where this server listens, and which addresses may reach it.";

/**
 * What an `https://` base URL costs, stated at the field.
 *
 * **The dashboard's own words, verbatim** —
 * `apps/server/web/src/components/networking/addresses-card.tsx` renders this
 * sentence beside the same field, and `settings-screen.test.ts` reads that file
 * and pins the two equal. Two surfaces disagreeing about a consequence is worse
 * than either wording alone, and this screen is the one people reach AFTER the
 * consequence has happened — so it had better be describing the same thing.
 *
 * A warning rather than a refusal: an https base URL is the RIGHT setting for
 * an instance people reach over the network. The cost just has to be visible at
 * the moment it is chosen rather than discovered at the next sign-in.
 */
export const HTTPS_LOCKOUT_WARNING =
  "An https address will sign this app's own window out for good: it loads this machine over http, and a Secure " +
  "session cookie is not kept on an http page. Browsers on the https address are unaffected.";

/** Whether this draft base URL is the value that locks this app's window out. */
export function httpsLockout(baseUrl: string): boolean {
  return baseUrl.trim().toLowerCase().startsWith("https://");
}

/**
 * Which of the four a restart is needed for, said once under the form.
 *
 * `TRUSTED_ORIGINS` became a live read on 2026-09-16 — the allowlist is
 * assembled per request — and the other three are still read at boot. The
 * dashboard's Addresses card decides its own button from exactly that split
 * (`LIVE_KEYS`); here there is one Save and one Restart, so the split is a
 * sentence rather than a branch.
 */
export const SETTINGS_RESTART_NOTE =
  "Port, bind address and public base URL take effect when the server restarts. Other addresses are picked up while it runs.";

/**
 * Why Save cannot run, or `null`.
 *
 * ONE reason, and it is the CLI's: `init` runs a tmux preflight and refuses
 * without it (`commands/init.ts`), so a Save on a machine with no tmux can only
 * produce that refusal. The recovery screen gates its own Set Up on the same
 * fact, which is where this rule comes from rather than from a guess about what
 * the CLI does.
 *
 * Everything else a save can hit — an unwritable config.env, a value the CLI
 * rejects — is the CLI's own answer, rendered verbatim where the person is.
 * Predicting those here would be a second validator to keep in step with the
 * one that decides.
 */
export function settingsSaveRefusal(probe: Probe | null): string | null {
  if (probe === null) return "Checking this machine…";
  if (probe.tmux === null) return "tmux is missing, and the server refuses to write its configuration without it.";
  return null;
}

/**
 * What a save says about supervision: **the machine as it already is**.
 *
 * This matters more than it looks. A save goes through `desktop_setup`, whose
 * `supervision` argument is OPTIONAL and whose absence means "a background
 * service, armed for login" — today's first-run chain, byte for byte. Sending
 * nothing from here would therefore install a service on a machine the operator
 * had deliberately put in app mode, and arm it at login, as a side effect of
 * editing a port. So the answer is read off the probe and sent every time: this
 * screen changes addresses and nothing else. **How Your Server Runs** is where
 * supervision is changed, and it is one screen away.
 */
export function settingsSupervision(probe: Probe): { background: boolean; autostart: boolean } {
  return { background: probe.supervision !== "app", autostart: probe.service?.enabled === true };
}

/**
 * The `desktop_setup` payload a Save sends.
 *
 * The addresses come from {@link configPayload}, which is the same contract the
 * first run's form has — a field nobody chose is sent EMPTY so the CLI keeps
 * deriving it, and a field that WAS chosen is sent even untouched, because
 * omitting a stored `trustedOrigins` would clear it.
 *
 * **The chain does more than write config.env, and it is worth knowing which
 * more.** `desktop_setup` installs the bundled server first, then `init`, then
 * the supervision steps. On the ordinary machine each of those is a no-op — the
 * bundled CLI is already installed, `service install` is idempotent — but on a
 * machine whose app ships a NEWER server than the one installed, a Save also
 * performs that (transactional, backed up) install. That is the same act the
 * update screen offers rather than a new one, and the alternative was a second
 * config-writing command, i.e. a wider IPC surface added in the name of fixing
 * a lockout.
 */
export function settingsPayload(probe: Probe, form: AddressForm): InitPayload {
  return { ...configPayload(form.values, form.explicit), supervision: settingsSupervision(probe) };
}

/**
 * The Force box for this screen's Restart, or `null` where no definition would
 * refuse.
 *
 * The same box, the same sentence and the same fail-closed rule as the update
 * act's (`lib/pane-force.ts`): this restart is that restart, so a person must
 * not meet two descriptions of one cost. `restarts` is unconditionally true
 * here — Restart is the button it sits under.
 */
export function settingsForce(probe: Probe | null, checked: boolean): PaneForce | null {
  return paneForceBox(probe, true, checked);
}

/**
 * Whether the form holds anything the machine does not already have.
 *
 * Compared against {@link effectiveForm}, i.e. what the inputs were seeded
 * with, so Save is dead until something is typed. Not a safety property — a
 * save of unchanged values is harmless — but a save that ran the whole chain to
 * write what was already there would read as the button having done something.
 */
export function settingsEdited(probe: Probe | null, form: AddressForm): boolean {
  const seeded = effectiveForm(probe?.status?.settings);
  return CONFIG_FIELDS.some(({ name }) => (form.values[name] ?? "").trim() !== (seeded[name] ?? "").trim());
}
