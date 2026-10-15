import { SSH_LOCAL_KEY_MAX_BYTES, SSH_LOCAL_KEY_TTL_MS } from "@internal/subshell-protocol";
import { createBrowserSshSigner } from "./ssh-browser-signer-core";

let signer: Awaited<ReturnType<typeof createBrowserSshSigner>> | undefined;
let opened = false;
let busy = false;
let stopped = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const stop = () => {
  stopped = true;
  signer?.close();
  signer = undefined;
  clearTimeout(timer);
  self.close();
};

// Messages originate in our wrapper. Keys/passphrases are never returned, even on failure.
self.onmessage = async ({ data }: MessageEvent) => {
  const id = data?.id;
  if (stopped || busy || !Number.isSafeInteger(id) || id < 1) {
    stop();
    return;
  }
  busy = true;
  let bytes: Uint8Array | undefined;
  let passphrase: Uint8Array | undefined;
  try {
    if (data.type === "open" && !opened) {
      opened = true;
      const expiresAt = Math.min(data.expiresAt, Date.now() + SSH_LOCAL_KEY_TTL_MS);
      passphrase = data.passphrase;
      if (
        !(data.file instanceof Blob) ||
        data.file.size === 0 ||
        data.file.size > SSH_LOCAL_KEY_MAX_BYTES ||
        !(passphrase instanceof Uint8Array) ||
        passphrase.length > 4096 ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now()
      )
        throw new Error("Choose a private key smaller than 64 KiB and a passphrase under 4 KiB.");
      timer = setTimeout(stop, expiresAt - Date.now());
      bytes = new Uint8Array(await data.file.arrayBuffer());
      signer = await createBrowserSshSigner({ bytes, passphrase, user: data.user, hostKey: data.hostKey, expiresAt });
      if (stopped || Date.now() >= expiresAt) throw new Error("The temporary SSH key expired. Choose it again.");
      self.postMessage({ id, result: { publicKey: signer.publicKey } });
    } else if (data.type === "request" && signer && typeof data.payload === "string") {
      const result = await signer.request(data.payload);
      if (stopped) return;
      self.postMessage({ id, result });
      if (result.done) stop();
    } else throw new Error("The temporary SSH key request is no longer available.");
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : "Couldn't use that SSH key." });
    stop();
  } finally {
    bytes?.fill(0);
    passphrase?.fill(0);
    busy = false;
  }
};
