/** Bounded desktop RPC concurrency. Slow host probing cannot stall traffic on
 * another active session; writes and closes retain ordering within one ref.
 * Refuse concurrent opens rather than stacking 30-second supervisor opens
 * behind a shorter control-plane RPC timeout. Every accepted task participates
 * in shutdown, including an open whose child has not reached hello yet.
 */
export class SshBrokerDispatcher {
  private readonly tasks = new Set<Promise<void>>();
  private readonly refTails = new Map<string, Promise<void>>();
  private opening = false;
  get size(): number {
    return this.tasks.size;
  }
  dispatch(
    command: { type: string; ref?: string },
    execute: () => Promise<void>,
    onError: (error: unknown) => void,
  ): "accepted" | "open_busy" | "full" {
    if (this.tasks.size >= 32) return "full";
    const opening = command.type === "ssh_session_open";
    if (opening && this.opening) return "open_busy";
    if (opening) this.opening = true;
    const ref = command.type === "ssh_session_send" || command.type === "ssh_session_close" ? command.ref : undefined;
    const previous = ref ? this.refTails.get(ref) : undefined;
    const task = (previous ?? Promise.resolve())
      .then(execute)
      .catch(onError)
      .finally(() => {
        this.tasks.delete(task);
        if (opening) this.opening = false;
        if (ref && this.refTails.get(ref) === task) this.refTails.delete(ref);
      });
    this.tasks.add(task);
    if (ref) this.refTails.set(ref, task);
    return "accepted";
  }
  async drain(): Promise<void> {
    await Promise.all([...this.tasks]);
  }
}
