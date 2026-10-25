import { expect, type Frame, type Page } from "@playwright/test";

/** Exercise browser-enforced boundaries, including direct links that bypass the iframe. */
export async function verifyPreviewBrowser(frame: Frame | Page, dashboardOrigin: string, embedded: boolean) {
  const result = await frame.evaluate(
    async ({ dashboardOrigin, embedded }) => {
      let parentBlocked = !embedded;
      if (embedded) {
        try {
          void window.parent.document.body;
        } catch {
          parentBlocked = true;
        }
      }
      let storageBlocked = false;
      try {
        localStorage.setItem("preview-isolation-check", "unsafe");
      } catch {
        storageBlocked = true;
      }
      let cookieBlocked = false;
      try {
        void document.cookie;
      } catch {
        cookieBlocked = true;
      }
      let workerBlocked = false;
      try {
        const worker = await navigator.serviceWorker.register(new URL("./worker.js", location.href).href);
        await worker.unregister();
      } catch {
        workerBlocked = true;
      }
      let apiBlocked = false;
      try {
        await fetch(`${dashboardOrigin}/api/subshells`, { credentials: "include" }).then((r) => r.text());
      } catch {
        apiBlocked = true;
      }
      const module = await import(new URL("./filter.js", location.href).href);
      const post = await fetch(new URL("./echo", location.href), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).then((r) => r.json());
      const websocket = await new Promise<string>((resolve, reject) => {
        const url = new URL("./socket", location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(url);
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error("Preview websocket timed out"));
        }, 5000);
        ws.onopen = () => ws.send("preview-echo");
        ws.onmessage = (event) => {
          clearTimeout(timeout);
          ws.close();
          resolve(String(event.data));
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("Preview websocket failed"));
        };
      });
      return {
        origin: self.origin,
        parentBlocked,
        storageBlocked,
        cookieBlocked,
        workerBlocked,
        apiBlocked,
        moduleLoaded: typeof module.filterProjects === "function",
        post: post.method,
        websocket,
      };
    },
    { dashboardOrigin, embedded },
  );
  expect(result).toEqual({
    origin: "null",
    parentBlocked: true,
    storageBlocked: true,
    cookieBlocked: true,
    workerBlocked: true,
    apiBlocked: true,
    moduleLoaded: true,
    post: "POST",
    websocket: "preview-echo",
  });
}
