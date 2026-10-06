import { SSH_RUNTIME_PROTOCOL, type SshRuntimeHelloWire, type SshSessionTargetWire } from "@internal/subshell-protocol";
import { SshRuntimeSession } from "@/services/ssh-runtime/session.js";

/**
 * A bare {@link SshRuntimeSession} for plane-side suites (cross-suite
 * fixture, hence `test-helpers/`). Deliberately DB-free: constructing and
 * registering a session is all the liveness-predicate and view tests need -
 * they assert on the REGISTRY's answer, not on rows (the open flow and its
 * settle writes are covered by the ssh-runtime suites, which use the real
 * scripted-node harness instead).
 */

/** The hello a session needs to exist (override any fact per test). */
export function runtimeHello(over: Partial<SshRuntimeHelloWire> = {}): SshRuntimeHelloWire {
  return {
    type: "hello",
    runtimeProtocol: SSH_RUNTIME_PROTOCOL,
    agentVersion: "1.5.0",
    os: "linux",
    arch: "x64",
    capabilities: ["ssh-runtime", "callback-sock", "detect", "pane-callback-sock"],
    homeDir: "/home/dst",
    dataDir: "/home/dst/.local/share/subshell/runtime",
    tmuxSocket: "subshell-ssh-fixture0000",
    paneCount: 0,
    ...over,
  };
}

/** The reviewed destination facts the session carries. */
export function runtimeTarget(over: Partial<SshSessionTargetWire> = {}): SshSessionTargetWire {
  return { alias: "fixture", host: "127.0.0.1", port: 22, user: null, identityFile: null, ...over };
}

/** A constructed (unregistered) live session with fresh ids unless named. */
export function mkRuntimeSession(
  over: Partial<{
    id: string;
    ownerId: string;
    connectingNodeId: string;
    runtimeNodeId: string;
    target: SshSessionTargetWire;
    hello: SshRuntimeHelloWire;
  }> = {},
): SshRuntimeSession {
  return new SshRuntimeSession({
    id: over.id ?? crypto.randomUUID(),
    ownerId: over.ownerId ?? "u-fixture-owner",
    connectingNodeId: over.connectingNodeId ?? "n-fixture-broker",
    runtimeNodeId: over.runtimeNodeId ?? crypto.randomUUID(),
    target: over.target ?? runtimeTarget(),
    hello: over.hello ?? runtimeHello(),
  });
}
