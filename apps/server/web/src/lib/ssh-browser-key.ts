import { SSH_LOCAL_KEY_TTL_MS } from "@internal/subshell-protocol";

export interface BrowserKeyMaterial {
  file: File;
  passphrase: Uint8Array;
}
export interface BrowserKeyScope {
  user: string;
  hostKey: string;
}
export interface LocalKeySigner {
  expiresAt: number;
  request(payload: string): Promise<{ response: string; done: boolean }>;
  close(): void;
}

export function browserSigningUnavailable(): string | null {
  if (!globalThis.isSecureContext || !globalThis.crypto?.subtle)
    return "Open Subshell over HTTPS to use a key in your browser. Localhost also works.";
  if (typeof Worker === "undefined") return "This browser can't run the temporary SSH signer. Try an updated browser.";
  return null;
}

/** The page passes a File handle; only the disposable worker reads its contents. */
export async function openBrowserKey(
  material: BrowserKeyMaterial,
  scope: BrowserKeyScope,
  signal: AbortSignal,
): Promise<LocalKeySigner> {
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
  let sequence = 0;
  let ended = false;
  const expiresAt = Date.now() + SSH_LOCAL_KEY_TTL_MS;
  const close = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", close);
    window.removeEventListener("pagehide", close);
    worker?.terminate();
    pending?.reject(new Error("Temporary SSH key access ended. Choose the key again."));
    pending = undefined;
  };
  const call = (body: Record<string, unknown>, transfer: Transferable[] = []): Promise<unknown> => {
    if (ended || pending || Date.now() >= expiresAt) {
      close();
      return Promise.reject(new Error("Temporary SSH key access ended. Choose the key again."));
    }
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending = { id, resolve, reject };
      try {
        worker?.postMessage({ ...body, id }, transfer);
      } catch {
        close();
      }
    });
  };
  try {
    const unavailable = browserSigningUnavailable();
    if (unavailable) throw new Error(unavailable);
    if (signal.aborted) throw new Error("SSH key selection was cancelled.");
    worker = new Worker(new URL("./ssh-browser-key.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (Date.now() >= expiresAt) {
        close();
        return;
      }
      if (!pending || !data || typeof data !== "object" || !("id" in data) || data.id !== pending.id) {
        close();
        return;
      }
      const current = pending;
      pending = undefined;
      if ("error" in data) {
        current.reject(new Error(typeof data.error === "string" ? data.error : "Couldn't use that SSH key."));
        close();
      } else if ("result" in data) current.resolve(data.result);
      else {
        current.reject(new Error("The temporary SSH signer returned an invalid reply."));
        close();
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      close();
    };
    worker.onmessageerror = close;
    signal.addEventListener("abort", close, { once: true });
    window.addEventListener("pagehide", close, { once: true });
    timer = setTimeout(close, SSH_LOCAL_KEY_TTL_MS);
    await call({ type: "open", file: material.file, passphrase: material.passphrase, ...scope, expiresAt }, [
      material.passphrase.buffer as ArrayBuffer,
    ]);
    if (ended || signal.aborted) throw new Error("SSH key selection was cancelled.");
    return {
      expiresAt,
      close,
      async request(payload) {
        const reply = await call({ type: "request", payload });
        if (
          !reply ||
          typeof reply !== "object" ||
          !("response" in reply) ||
          typeof reply.response !== "string" ||
          !("done" in reply) ||
          typeof reply.done !== "boolean"
        ) {
          close();
          throw new Error("The temporary SSH signer returned an invalid reply.");
        }
        if (reply.done) close();
        return { response: reply.response, done: reply.done };
      },
    };
  } catch (error) {
    close();
    throw error;
  } finally {
    // Successful transfer detaches this buffer. Failed construction must wipe it too.
    if (material.passphrase.byteLength) material.passphrase.fill(0);
  }
}
