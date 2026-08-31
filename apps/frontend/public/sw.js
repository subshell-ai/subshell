/*
 * mote service worker — classic worker, event plumbing only.
 * The decision logic lives in sw-handlers.js (self.MoteSw) so it can be
 * unit-tested by eval'ing that file into a fake `self`.
 */
importScripts("/sw-handlers.js");

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let data;
      try {
        data = event.data ? event.data.json() : null;
      } catch {
        return; // malformed payload — nothing sensible to show
      }
      if (!data) return;
      const list = await self.clients.matchAll({ type: "window" });
      const focusedClient = list.find((c) => c.focused);
      if (!self.MoteSw.shouldShow(data, focusedClient ? focusedClient.url : null)) return;
      const [title, options] = self.MoteSw.noteArgs(data);
      await self.registration.showNotification(title, options);
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const data = event.notification.data;
      if (!data || typeof data.url !== "string") return;
      const target = self.MoteSw.clickTarget(data);
      const list = await self.clients.matchAll({ type: "window" });
      const match = list.find((c) => c.url.includes(data.url));
      if (match) return match.focus();
      return self.clients.openWindow(target);
    })(),
  );
});
