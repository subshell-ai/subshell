import { isAndroid, isIOS } from "@/lib/platform";

/**
 * Which set of install steps the dialog shows. Three because they are three
 * different gestures, not three brandings: a desktop browser installs from its
 * address bar, iOS from the share sheet, Android from the overflow menu.
 *
 * (The address half of the dialog lives in `lib/install-addresses.ts` —
 * shared with the Add-node dialog's address picker.)
 */
export type InstallPlatform = "browser" | "apple" | "android";

/**
 * The tab to open on — the steps for the device actually reading the dialog.
 *
 * A guess, and always overridable: someone at a desktop looking up what their
 * phone should do is a normal reason to be here, which is why every tab stays
 * one click away rather than the other two being hidden.
 */
export function installPlatformFor(
  ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
  // `?? 0` is not belt and braces: a default parameter applies only to a
  // MISSING argument, and this expression can itself evaluate to undefined
  // (an old WebView, a test DOM) while its type says `number` — so the
  // coalesce is what makes the annotation true.
  touchPoints: number = typeof navigator === "undefined" ? 0 : (navigator.maxTouchPoints ?? 0),
): InstallPlatform {
  if (isIOS(ua, touchPoints)) return "apple";
  if (isAndroid(ua)) return "android";
  return "browser";
}
