import { afterEach, beforeEach, expect, it } from "bun:test";
import { openBrowserKey } from "../ssh-browser-key";

const originalWorker = globalThis.Worker;
const originalSecure = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
const workers: FakeWorker[] = [];
class FakeWorker {
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { preventDefault(): void }) => void;
  onmessageerror?: () => void;
  messages: Record<string, unknown>[] = [];
  transfers: Transferable[][] = [];
  terminated = false;
  constructor() {
    workers.push(this);
  }
  postMessage(value: Record<string, unknown>, transfer: Transferable[]) {
    this.messages.push(value);
    this.transfers.push(transfer);
  }
  terminate() {
    this.terminated = true;
  }
  reply(result: unknown) {
    this.onmessage?.({ data: { id: this.messages.at(-1)?.id, result } });
  }
}
beforeEach(() => {
  workers.length = 0;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  Object.defineProperty(globalThis, "isSecureContext", { value: true, configurable: true });
});
afterEach(() => {
  globalThis.Worker = originalWorker;
  if (originalSecure) Object.defineProperty(globalThis, "isSecureContext", originalSecure);
  else Reflect.deleteProperty(globalThis, "isSecureContext");
});
const scope = { user: "alice", hostKey: "approved-public-host" };
const material = () => ({ file: new File(["fixture-key"], "id_ed25519"), passphrase: new Uint8Array([1, 2, 3]) });

it("transfers the passphrase buffer to a disposable worker and terminates after one signature", async () => {
  const key = material();
  const opening = openBrowserKey(key, scope, new AbortController().signal);
  const worker = workers[0];
  expect(worker.messages[0].file).toBe(key.file);
  expect(worker.messages[0].user).toBe("alice");
  expect(worker.messages[0].hostKey).toBe(scope.hostKey);
  expect(worker.transfers[0]).toEqual([key.passphrase.buffer]);
  worker.reply({ publicKey: "public" });
  const signer = await opening;
  expect([...key.passphrase]).toEqual([0, 0, 0]);
  const request = signer.request("public-request");
  worker.reply({ response: "Dg==", done: true });
  expect(await request).toEqual({ response: "Dg==", done: true });
  expect(worker.terminated).toBe(true);
  await expect(signer.request("second")).rejects.toThrow("ended");
});

it("cancels a worker even while key decryption is pending", async () => {
  const abort = new AbortController();
  const key = material();
  const opening = openBrowserKey(key, scope, abort.signal);
  abort.abort();
  await expect(opening).rejects.toThrow("ended");
  expect(workers[0].terminated).toBe(true);
  expect([...key.passphrase]).toEqual([0, 0, 0]);
});

it("cleans up failed construction and refuses non-secure pages before creating a worker", async () => {
  Object.defineProperty(globalThis, "isSecureContext", { value: false, configurable: true });
  const key = material();
  await expect(openBrowserKey(key, scope, new AbortController().signal)).rejects.toThrow("HTTPS");
  expect(workers).toHaveLength(0);
  expect([...key.passphrase]).toEqual([0, 0, 0]);
});

it("rejects an out-of-sequence worker response and cancels on pagehide", async () => {
  const key = material();
  const opening = openBrowserKey(key, scope, new AbortController().signal);
  workers[0].onmessage?.({ data: { id: 200, result: {} } });
  await expect(opening).rejects.toThrow("ended");
  const next = openBrowserKey(material(), scope, new AbortController().signal);
  workers[1].reply({ publicKey: "public" });
  const signer = await next;
  window.dispatchEvent(new Event("pagehide"));
  expect(workers[1].terminated).toBe(true);
  await expect(signer.request("request")).rejects.toThrow("ended");
});
