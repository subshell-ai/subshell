/** Read a response within a byte budget, cancelling instead of draining excess input. */
export async function readResponseBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid response byte limit");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    if (Number(response.headers.get("content-length")) > maxBytes) {
      throw new Error(`response exceeds ${maxBytes} bytes`);
    }
    // Count delivered bytes too: Content-Length can be absent, false, or
    // describe a compressed body that fetch has already decompressed.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
