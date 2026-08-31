/*
 * Service-worker decision logic, as a plain script (no modules — a classic
 * SW has no import graph). The worker pulls it in with importScripts("/sw-handlers.js");
 * the bun tests eval this exact file text against a fake `self`.
 * Keep it dependency-free so both runtimes accept it.
 */
{
  /**
   * Whether a push payload deserves a visible notification.
   * False only when the user is already looking at the target page
   * (a focused window whose URL contains the payload's relative url).
   */
  const shouldShow = (data, focusedClientUrl) => {
    if (!data || typeof data.url !== "string" || !focusedClientUrl) return true;
    return focusedClientUrl.indexOf(data.url) === -1;
  };

  /** The showNotification option bag for a payload (title kept inside for tests). */
  const noteOptions = (data) => ({ title: data.title, body: data.body, tag: data.tag, data });

  /** The exact (title, options) pair for registration.showNotification(...args). */
  const noteArgs = (data) => [data.title, { body: data.body, tag: data.tag, data }];

  /** Absolute click destination for a payload's (possibly relative) url. */
  const clickTarget = (data) => new URL(data.url, self.location.origin).href;

  self.MoteSw = { shouldShow, noteOptions, noteArgs, clickTarget };
}
