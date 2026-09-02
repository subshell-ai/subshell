import { EventEmitter } from "node:events";

/**
 * In-process wake-up bus for channel posts.
 *
 * The subshell backend is a single process; long-poll readers subscribe here and
 * post-appending writers notify after their DB transaction commits. There is
 * deliberately no persistence or cross-process fan-out — durability is the
 * post log itself, and a missed wake-up only costs the waiter its timeout
 * (the next poll still returns everything from the cursor).
 */
const bus = new EventEmitter();
bus.setMaxListeners(0); // one waiter per long-poll client; unbounded by design

/** Signals that channelId has new posts. */
export function notifyPosts(channelId: string): void {
  bus.emit(channelId);
}

/**
 * Subscribes to new-post signals for one channel.
 * @returns an unsubscribe function (call it in a finally block)
 */
export function subscribe(channelId: string, cb: () => void): () => void {
  bus.on(channelId, cb);
  return () => {
    bus.off(channelId, cb);
  };
}
