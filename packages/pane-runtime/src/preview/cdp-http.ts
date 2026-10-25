/** CDP discovery must stay on the requested loopback endpoint and fit in memory. */
export async function fetchCdpJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, redirect: "error" });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`CDP discovery answered ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024) throw new Error("CDP discovery exceeds 256 KiB");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
