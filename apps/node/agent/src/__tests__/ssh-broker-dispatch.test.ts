import { expect, test } from "bun:test";
import { SshBrokerDispatcher } from "../ssh-broker-dispatch.js";

test("paused open cannot block an existing session send or close, and a second open refuses immediately", async () => {
  const dispatcher = new SshBrokerDispatcher();
  const events: string[] = [];
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const error = () => {
    throw new Error("Dispatch should not fail");
  };
  expect(
    dispatcher.dispatch(
      { type: "ssh_session_open", ref: "new" },
      async () => {
        events.push("opening");
        await paused;
        events.push("opened");
      },
      error,
    ),
  ).toBe("accepted");
  expect(
    dispatcher.dispatch(
      { type: "ssh_session_open", ref: "other" },
      async () => {
        events.push("unwanted second open");
      },
      error,
    ),
  ).toBe("open_busy");
  expect(
    dispatcher.dispatch(
      { type: "ssh_session_send", ref: "existing" },
      async () => {
        events.push("sent");
      },
      error,
    ),
  ).toBe("accepted");
  expect(
    dispatcher.dispatch(
      { type: "ssh_session_close", ref: "existing" },
      async () => {
        events.push("closed");
      },
      error,
    ),
  ).toBe("accepted");
  await Bun.sleep(1);
  expect(events).toEqual(["opening", "sent", "closed"]);
  let drained = false;
  const draining = dispatcher.drain().then(() => {
    drained = true;
  });
  await Bun.sleep(1);
  expect(drained).toBe(false);
  resume();
  await draining;
  expect(events).toEqual(["opening", "sent", "closed", "opened"]);
  expect(dispatcher.size).toBe(0);
});

test("dispatch bounds pending commands and preserves ordering per session without blocking unrelated refs", async () => {
  const dispatcher = new SshBrokerDispatcher();
  let resume!: () => void;
  const pause = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const events: string[] = [];
  const error = () => {};
  dispatcher.dispatch(
    { type: "ssh_session_send", ref: "first" },
    async () => {
      await pause;
      events.push("first send");
    },
    error,
  );
  dispatcher.dispatch(
    { type: "ssh_session_close", ref: "first" },
    async () => {
      events.push("first close");
    },
    error,
  );
  dispatcher.dispatch(
    { type: "ssh_session_send", ref: "second" },
    async () => {
      events.push("second send");
    },
    error,
  );
  await Bun.sleep(1);
  expect(events).toEqual(["second send"]);
  for (let i = dispatcher.size; i < 32; i++)
    expect(
      dispatcher.dispatch(
        { type: "ssh_resolve_config" },
        async () => {
          await pause;
        },
        error,
      ),
    ).toBe("accepted");
  expect(dispatcher.dispatch({ type: "ssh_discover_aliases" }, async () => {}, error)).toBe("full");
  resume();
  await dispatcher.drain();
  expect(events).toEqual(["second send", "first send", "first close"]);
  expect(dispatcher.size).toBe(0);
});
