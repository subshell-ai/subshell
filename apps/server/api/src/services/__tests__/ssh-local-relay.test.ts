import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, seal } from "@internal/mcp-core";
import {
  MachinePinStore,
  OPENSSH_10X_SCHEME,
  openARelaySession,
  openBRelaySession,
  RelaySessions,
  requestLiveAgent,
} from "@internal/pane-runtime";
import type { RelayFrame } from "@internal/subshell-protocol";
import { createLocalRelayIdentityProvider } from "../ssh-local-identity.js";
import { createLocalRelayParticipant } from "../ssh-local-participant.js";
import { createRelayBroker } from "../ssh-relay.service.js";
import {
  buildSignRequestTenX,
  fp,
  KEY_IN,
  KEY_OUT,
  parseAnswer,
  ROSTER,
  startStubAgent,
} from "./helpers/ssh-relay-stack.js";

for (const localRole of ["A", "B"] as const)
  test(`sealed relay with server as ${localRole}: selection, pins, routing and teardown`, async () => {
    const root = await mkdtemp(join(tmpdir(), "local-relay-"));
    const localDir = join(root, "server");
    const remoteDir = join(root, "node");
    const localIdentity = createLocalRelayIdentityProvider(join(localDir, "ssh-relay"), async () => {});
    const remoteIdentity = createLocalRelayIdentityProvider(remoteDir, async () => {});
    const [localKeys, remoteKeys] = await Promise.all([localIdentity(), remoteIdentity()]);
    const agent = await startStubAgent(ROSTER, OPENSSH_10X_SCHEME);
    const remoteSessions = new RelaySessions();
    const frames: RelayFrame[] = [];
    const aNode = localRole === "A" ? "local" : "remote";
    const bNode = localRole === "B" ? "local" : "remote";
    const participant = createLocalRelayParticipant({
      dataDir: localDir,
      identityDir: join(localDir, "ssh-relay"),
      identity: localIdentity,
      resolveAgentSocket: () => agent.path,
      log: () => {},
      sendRelayFrame: (frame) => {
        frames.push(frame);
        broker.routeRelayFrame("local", frame);
      },
    });
    const broker = createRelayBroker({
      nodeRow: async (id) => ({ kind: id === "local" ? "local" : "agent", sshEnabled: 1 }),
      nodeDataDir: (id) => (id === "local" ? localDir : remoteDir),
      authorize: async () => true,
      nowMs: Date.now,
      audit: async () => {},
      log: () => {},
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      sendRelayFrame: (id, frame) =>
        id === "local" ? participant.inbound(frame) : remoteSessions.onInboundRelayFrame(frame),
      sendCommand: async (id, cmd) => {
        if (id === "local") return participant.command(cmd);
        if (cmd.type === "ssh_relay_close") return { closed: remoteSessions.close(cmd.ref, cmd.reason) };
        if (cmd.type !== "ssh_relay_open") throw new Error("unexpected command");
        const args = {
          cmd,
          relay: remoteSessions,
          dataDir: remoteDir,
          selfNodeId: "remote",
          identity: remoteIdentity,
          seal,
          open,
          resolveAgentSocket: () => agent.path,
          sendRelayFrame: (frame: RelayFrame) => {
            frames.push(frame);
            broker.routeRelayFrame("remote", frame);
          },
        };
        if (cmd.role === "A") {
          // The node acknowledges before its asynchronous open finishes. The shared
          // pending handler must keep B's first request until identity/probe is ready.
          void openARelaySession({
            ...args,
            identity: async () => {
              await new Promise((resolve) => setTimeout(resolve, 30));
              return remoteIdentity();
            },
          });
          return { role: "A", relayId: cmd.relayId, pending: true };
        }
        return openBRelaySession({ ...args, paneId: cmd.paneId });
      },
    });
    try {
      const peer = (keys: typeof localKeys) => ({
        signingPublicKey: keys.signingPublicJwk,
        encryptionPublicJwk: keys.publicJwk,
      });
      const opened = await broker.openRelay({
        identityGenerations: { a: broker.identityGeneration(aNode), b: broker.identityGeneration(bNode) },
        userId: "test-user",
        aNode,
        bNode,
        aPeer: peer(localRole === "A" ? localKeys : remoteKeys),
        bPeer: peer(localRole === "B" ? localKeys : remoteKeys),
        fingerprints: [fp(KEY_IN)],
        paneId: crypto.randomUUID(),
        hostPin: "host ssh-ed25519 AAAA",
      });
      expect(new MachinePinStore(join(localDir, "ssh-relay")).get("remote")).toEqual({
        signing: remoteKeys.signingPublicJwk,
        encryption: remoteKeys.publicJwk,
      });
      const answer = await requestLiveAgent(opened.socketPath, Buffer.from([11]));
      expect(parseAnswer(answer).count).toBe(1);
      const before = agent.received.length;
      expect(await requestLiveAgent(opened.socketPath, buildSignRequestTenX(KEY_OUT))).toEqual(Buffer.from([5]));
      expect(agent.received.length).toBe(before);
      expect((await requestLiveAgent(opened.socketPath, buildSignRequestTenX(KEY_IN)))[0]).toBe(14);
      const request = frames.find((frame) => frame.direction === "B2A");
      if (!request) throw new Error("missing sealed agent request");
      broker.routeRelayFrame("outsider", request);
      broker.routeRelayFrame(bNode, { ...request, direction: "A2B" });
      broker.routeRelayFrame(bNode, request); // valid envelope replay is refused by the receiver sequence gate
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(agent.received.length).toBe(before + 1);
      expect(JSON.stringify(frames)).not.toContain("KEY-IN");
      await broker.shutdown();
      participant.closeAll();
      expect(participant.sessions.size).toBe(0);
      expect(remoteSessions.size).toBe(0);
      expect(existsSync(opened.socketPath)).toBe(false);
    } finally {
      participant.closeAll();
      remoteSessions.closeAll("test");
      broker.reset();
      await agent.close();
      await rm(root, { recursive: true, force: true });
    }
  });
