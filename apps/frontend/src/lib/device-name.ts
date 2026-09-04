/**
 * This device's name, as shown to other viewers of a shared subshell.
 *
 * A subshell can be open on several devices at once and they all constrain
 * one pane, so the Devices list has to say WHICH device is which. There is no
 * device identity to borrow: `device_tokens` is the native app's push
 * mailbox, and every other per-device setting is a bare localStorage value
 * (terminal font size, swipe-nav opt-out). So this follows the same pattern —
 * a per-device name, defaulted from the User-Agent and editable later.
 *
 * The default is deliberately coarse ("Safari on iPad", not a fingerprint):
 * enough to tell a phone from a laptop in a list the user already knows the
 * membership of, and nothing more. It is sent to the server on attach and
 * shown to everyone who can see the subshell, which for a shared subshell may
 * be another user — so it must not carry anything a browser would not already
 * put in a User-Agent header.
 */

import { normalizeDeviceLabel } from "@internal/subshell-protocol";

/** localStorage key holding this device's chosen name. */
export const DEVICE_NAME_KEY = "subshell.deviceName";

/** What a device is called when nothing can be derived at all. */
export const DEVICE_NAME_FALLBACK = "This device";

/** Browser families worth naming, longest-match first (Chrome's UA says Safari). */
const BROWSERS: ReadonlyArray<readonly [pattern: RegExp, name: string]> = [
  [/\bEdg\//, "Edge"],
  [/\bOPR\//, "Opera"],
  [/\bFirefox\//, "Firefox"],
  [/\bCriOS\//, "Chrome"],
  [/\bFxiOS\//, "Firefox"],
  [/\bChrome\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];

/** Platforms worth naming, checked before the generic desktop cases. */
const PLATFORMS: ReadonlyArray<readonly [pattern: RegExp, name: string]> = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bWindows\b/, "Windows"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b/, "Linux"],
];

/**
 * A readable name for a User-Agent string, e.g. `"Safari on iPad"`.
 *
 * Exported for its tests; prefer {@link deviceName}, which remembers the
 * user's own choice.
 *
 * @param userAgent - The raw User-Agent string
 * @returns A short device name, never empty
 */
export function deviceNameFromUserAgent(userAgent: string): string {
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const platform = PLATFORMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (browser && platform) return `${browser} on ${platform}`;
  return browser ?? platform ?? DEVICE_NAME_FALLBACK;
}

/**
 * This device's name: the user's stored choice, else one derived from the
 * User-Agent.
 *
 * Never throws — private-mode Safari denies localStorage access outright, and
 * a device that cannot remember a name still deserves one.
 *
 * @returns The device name
 */
export function deviceName(): string {
  try {
    const stored = normalizeDeviceLabel(window.localStorage.getItem(DEVICE_NAME_KEY) ?? "");
    if (stored) return stored;
  } catch {
    // storage denied; fall through to the derived name
  }
  const derived = normalizeDeviceLabel(deviceNameFromUserAgent(navigator.userAgent ?? ""));
  return derived || DEVICE_NAME_FALLBACK;
}

/**
 * Stores a chosen device name, or clears it to fall back to the derived one.
 * @param name - The new name; blank clears the override
 */
export function setDeviceName(name: string): void {
  const cleaned = normalizeDeviceLabel(name);
  try {
    if (cleaned) window.localStorage.setItem(DEVICE_NAME_KEY, cleaned);
    else window.localStorage.removeItem(DEVICE_NAME_KEY);
  } catch {
    // storage denied; the derived name stands for this session
  }
}
