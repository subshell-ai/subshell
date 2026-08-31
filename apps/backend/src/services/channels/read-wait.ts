import { subscribe } from "@/services/channels/post-bus.js";

/**
 * Long-poll primitive for channel reads: returns as soon as `hasNew()` turns
 * true (driven by the post bus, with a re-check because events are not
 * authoritative), when the wait budget runs out, or when the client aborts.
 *
 * A returning-late `hasNew` is fine — callers re-read after this resolves and
 * simply report `{posts: []}` if nothing matched after all. (A post landing
 * in the tiny window between the pre-check and `subscribe()` misses its event
 * and waits out the budget — accepted: one-shot latency, never a lost post,
 * since the caller's re-read after resolve sees everything regardless.)
 *
 * @param input - channelId to watch, hasNew probe, wait budget ms, abort signal
 */
export async function waitForNewPosts(input: {
  channelId: string;
  hasNew: () => Promise<boolean>;
  waitMs: number;
  signal: AbortSignal;
}): Promise<void> {
  if (await input.hasNew()) return;
  if (input.waitMs <= 0) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      unsubscribe();
      input.signal.removeEventListener("abort", finish);
      resolve();
    };
    const unsubscribe = subscribe(input.channelId, () => {
      void input.hasNew().then((yes) => {
        if (yes) finish();
      });
    });
    const timer = setTimeout(finish, input.waitMs);
    input.signal.addEventListener("abort", finish, { once: true });
  });
}
