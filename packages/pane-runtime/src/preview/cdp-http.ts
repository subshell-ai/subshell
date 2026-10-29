/**
 * CDP discovery and the bridge's bootstrap read one port over loopback, and a
 * browser bound to only one family is routine. These reads therefore try both
 * spellings of loopback, in the same order the forward lane dials them
 * (`forward.ts`): v4 first, then v6 when v4 supplies no usable CDP document. Keeping the
 * family list here means discovery, the bridge, and the lane cannot drift into
 * different spellings of loopback, which is what
 * made an IPv6-only devtools endpoint discoverable as a website yet never as a
 * browser to watch.
 */

/** The loopback spellings, in dial order: IPv4 first, then IPv6. */
export const CDP_LOOPBACK_FAMILIES = ["127.0.0.1", "[::1]"] as const;

/** CDP discovery must stay on the requested loopback endpoint and fit in memory. */
async function fetchCdpJsonAt(url: string, signal: AbortSignal, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, { signal, redirect: "error" });
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

/**
 * Fetch one CDP path on the named loopback URL and parse its bounded JSON.
 */
export async function fetchCdpJson(url: string, signal: AbortSignal): Promise<unknown> {
  return fetchCdpJsonAt(url, signal, globalThis.fetch);
}

/**
 * Fetch `path` on `port` from whichever loopback family answers.
 *
 * A family that throws (refused, or out of its window) hands the question to the
 * next; a non-2xx, oversized body, or JSON rejected by `accept` is an answer that
 * refuses CDP on that socket, and the next family is a different socket which may
 * hold the real endpoint, so the walk continues rather than trusting one "no".
 * When nothing answers, the last failure is what the caller hears: it names the
 * family that came closest, which is the more useful of the two. The caller's
 * signal is the outer bound; `perFamilyTimeoutMs`, when given, is each family's
 * own slice, so one stalled socket cannot spend the whole budget before the
 * other is asked.
 */
export async function fetchCdpJsonFromLoopback(
  port: number,
  path: string,
  signal: AbortSignal,
  opts: { perFamilyTimeoutMs?: number; fetchImpl?: typeof fetch; accept?: (body: unknown) => boolean } = {},
): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  let lastError: unknown;
  for (const host of CDP_LOOPBACK_FAMILIES) {
    const attempt =
      opts.perFamilyTimeoutMs === undefined
        ? signal
        : AbortSignal.any([signal, AbortSignal.timeout(opts.perFamilyTimeoutMs)]);
    try {
      const body = await fetchCdpJsonAt(`http://${host}:${port}${path}`, attempt, fetchImpl);
      if (opts.accept && !opts.accept(body)) throw new Error("Loopback response is not the requested CDP document");
      return body;
    } catch (err) {
      // The caller gave up (the scan ended, the handshake died): that is the
      // answer, and asking the other family would only delay it.
      if (signal.aborted) throw err;
      lastError = err;
    }
  }
  throw lastError;
}
