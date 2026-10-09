import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type APIRequestContext, expect, type PlaywrightWorkerArgs, test } from "@playwright/test";
import { missingSshBins, SSH_FIXTURE_ALIAS } from "../fixtures/sshd";
import { RELAY_HANG_ALIAS, startRelayFixture } from "../fixtures/sshd-relay";
import { NODE_MAIN, startNode } from "../stub/client";
import {
  AGENT_FAILURE,
  agentRoundTrip,
  assertValidSignature,
  buildSignRequest,
  CAPTURE_TIMEOUT,
  fingerprint,
  killGroup,
  modeOf,
  parseIdentitiesAnswer,
  pollUntil,
  pollUntilResult,
  pubBlob,
  READY_TIMEOUT,
  RELAY_ORIGIN,
  readCapture,
  readdirSafe,
  sleep,
  sshStr,
  startRelayBackend,
  stopRelayBackend,
  sweepTmux,
  TEN_X,
} from "../stub/relay-spec";

/**
 * The crown jewel (spec 2026-10-08 §13, parent §14): the sealed agent relay
 * end to end over a REAL ssh-agent, a REAL sshd, and the REAL plane. Nothing
 * on the authentication path is stubbed:
 *
 *  - **D** is a real sshd whose `authorized_keys` trusts exactly A's client
 *    key (fixtures/sshd-relay.ts);
 *  - **A** is a real enrolled `subshell` node agent, spawned with
 *    `SSH_AUTH_SOCK` pointed at a REAL `ssh-agent` on this host (OpenSSH
 *    10.x) that really holds A's keys, and `HOME` pointed at the home whose
 *    `known_hosts` pre-pins D (the §9 pin-capture source);
 *  - **B** is a real enrolled node agent that holds NO key and has NO agent
 *    socket - its pane's `ssh` is invoked with `SSH_AUTH_SOCK` pointed at the
 *    relay PROXY socket B's node binds at `<dataDir>/ssh/<pane>/agent.sock`,
 *    and its only trust source is the pinned file the signed relay-open
 *    delivered;
 *  - the **plane** is this spec's own backend (port `relay`), booted under a
 *    `--preload` that records every relay frame the broker routes, blind, in
 *    the exact shape the plane sees it.
 *
 * What is asserted, and where it comes from (design §13 / parent §14):
 *  1. B authenticates to D THROUGH the plane relay: the remote shell's own
 *     evaluated marker lands in the pane log, and sshd's VERBOSE log records
 *     `Accepted publickey` for A's fingerprint - a key B never held.
 *  2. The plane-side capture shows ONLY opaque envelopes + plaintext routing
 *     ids: every recorded frame's blob is base64 of a JWE (General) JSON with
 *     ciphertext/iv/tag, and A's key material, the signature bytes, the
 *     agent wire, the selected fingerprints, and the typed markers appear
 *     NOWHERE in the capture file.
 *  3. The REAL OpenSSH agent numbering is honored end to end: the responder's
 *     probe ran against the actual ssh-agent (10.x: identities 11 / answer 12
 *     / sign 13 / sign-response 14 + the RFC 9987 extended grammar), a raw
 *     identities request over B's proxy socket answers with the agent's own
 *     12 and the FILTERED roster, a raw sign for the selected blob comes back
 *     as a real 14-signature that VERIFIES against A's public key, and the
 *     colliding bytes (classic-13-as-roster, classic-15, SSH1-era, mutation
 *     codes) answer FAILURE without ever reaching the agent. This is the
 *     arbiter the hand-spelled stub agents could not settle.
 *  4. A launch-share revoke between the relay handshake and D stops signing: on a
 *     pane whose ssh sits in the banner wait against a never-answers
 *     listener, the proxy answers identities, launch access is revoked, and the
 *     socket is gone (the plane's close audit names `access-revoked`).
 *  5. "Set up Subshell here" turns D into an enrolled node through the REAL
 *     install pipeline (spec §7) - and the minted setup key appears nowhere
 *     in B's pane log. D's session env is pinned by sshd `SetEnv` to scratch
 *     paths, so the installer act runs for real while writing nothing to the
 *     developer's home.
 *  6. A changed D host key is the hard block (OpenSSH refuses the connection
 *     against the pinned file); deleting the pin and letting the fresh
 *     capture read A's re-trusted `known_hosts` recovers TOFU.
 *
 * Real vs stubbed, honestly: the sshd, the agent, the client, both node
 * daemons, the broker, the responder, the proxy, the crypto, and the
 * installer are all real. The only scripted piece is the node binary the
 * install fetches: the air-gapped e2e plane serves a ~20-line wrapper that
 * execs `bun <source>/main.ts` - the suite's Phase-3 deviation #1 (the same
 * source the plane's own enrolled agents run). And the plane-side "capture"
 * is the broker's own routing seam (the frame objects the production broker
 * receives), recorded through the preloads' test wrapper, because the
 * node-link bytes on the TCP wire are secretstream ciphertext the spec could
 * only echo back as ciphertext.
 *
 * Binaries: ssh, ssh-keygen, sshd, ssh-agent, ssh-add (gate:
 * `missingSshBins`, loud skip). Serial by suite design (`workers: 1`).
 */

const ORIGIN = RELAY_ORIGIN;

const missing = missingSshBins();
test.skip(
  missing.length > 0,
  `SSH binaries absent on this host (${missing.join(", ")}) - spec 23 needs a real sshd AND a real ssh-agent`,
);

const ADMIN = { name: "Relay Admin", email: "relay-admin@subshell.test", password: "e2e-relay-admin-pass-1" } as const;

function freshCtx(playwright: PlaywrightWorkerArgs["playwright"]): Promise<APIRequestContext> {
  return playwright.request.newContext({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] } });
}

/* ------------------------------------------------------------------ */
/* the story                                                           */
/* ------------------------------------------------------------------ */

test.describe("ssh relay crown jewel (spec 2026-10-08 §13)", () => {
  test("real agent on A, real sshd D, no key on B: the relay authenticates, the plane sees only envelopes, the 10.x numbering survives, revoke stops signing, set-up-here enrolls clean, and changed-host-key TOFU recovers", async ({
    playwright,
  }) => {
    test.setTimeout(600_000);
    const nonce = test.info().retry;

    // Honest timeline: each stage boundary prints its elapsed seconds, so a
    // GREEN run is auditable down to WHERE the story's seconds went (the
    // 30 s relay lifetime cap in particular cannot hide a skipped leg).
    const storyT0 = Date.now();
    const stage = (name: string): void => {
      console.log(`[23-ssh-relay] ${name} @${((Date.now() - storyT0) / 1000).toFixed(1)}s`);
    };
    stage("story start");

    const leaks: string[] = [];
    const cleanupFns: { name: string; run: () => Promise<void> | void }[] = [];
    const cleanup = (name: string, run: () => Promise<void> | void): void => {
      cleanupFns.push({ name, run });
    };

    let admin: APIRequestContext | undefined;
    let dDaemonPid: number | undefined;
    const paneIds: string[] = [];

    try {
      // ── Stage 0: the world. Scratch paths for the D session (the installer
      // sandbox), the real sshd + hang listener + two homes, the real agent.
      const root = mkdtempSync(path.join(tmpdir(), "subshell-e2e-relaytier-"));
      cleanup("temp root", () => rmSync(root, { recursive: true, force: true }));
      const dconf = path.join(root, "dconf"); // D's SUBSHELL_CONFIG_HOME (SetEnv)
      const dnode = path.join(root, "dnode"); // D's install data dir (SetEnv)
      const dTmux = path.join(root, "dtmux"); // D daemon's tmux home
      mkdirSync(dconf, { mode: 0o700, recursive: true });

      // The wrapper "binary" the installer will fetch: execs the agent from
      // source (deviation #1), with the runner's own bun (or which(bun)).
      const bunBin =
        path.basename(process.execPath) === "bun"
          ? process.execPath
          : spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim() || "bun";
      const nodeMainTs = NODE_MAIN;

      const D = await startRelayFixture(root, {
        setEnv: {
          SUBSHELL_CONFIG_HOME: dconf,
          SUBSHELL_DATA_DIR: dnode,
          SUBSHELL_NO_SERVICE: "1", // enrollment for real; the test spawns the daemon itself
        },
      });
      cleanup("relay fixture", async () => {
        await D.stop();
      });

      // The REAL ssh-agent holding A's keys; B never sees this socket.
      const agentOut = spawnSync("ssh-agent", ["-s"], { encoding: "utf8" });
      if (agentOut.status !== 0) throw new Error(`[stage 0] ssh-agent failed: ${agentOut.stderr}`);
      const agentSock = agentOut.stdout.match(/SSH_AUTH_SOCK=([^;]+)/)?.[1] ?? "";
      const agentPid = Number(agentOut.stdout.match(/SSH_AGENT_PID=([^;]+)/)?.[1]);
      if (!agentSock || !Number.isInteger(agentPid) || agentPid <= 0) {
        throw new Error(`[stage 0] ssh-agent output unparseable: ${agentOut.stdout.slice(0, 200)}`);
      }
      cleanup("ssh-agent", () => killGroup(agentPid, "SIGTERM"));
      for (const key of [D.keyA, D.keyA2]) {
        const add = spawnSync("ssh-add", [key], {
          env: { ...process.env, SSH_AUTH_SOCK: agentSock },
          encoding: "utf8",
        });
        if (add.status !== 0) throw new Error(`[stage 0] ssh-add ${key}: ${add.stderr}`);
      }
      // The fingerprints the story matches on, computed INDEPENDENTLY over
      // each public blob (SHA-256, base64url, OpenSSH's display spelling), and
      // then cross-checked against what the REAL agent itself reports via
      // ssh-add -l: the roster, the grant, and the proxy answers must all
      // agree with this arithmetic, not with each other.
      const blobOf = (keyPath: string): Buffer => pubBlob(`${keyPath}.pub`);
      const fpA = fingerprint(blobOf(D.keyA));
      const fpA2 = fingerprint(blobOf(D.keyA2));
      const addList = spawnSync("ssh-add", ["-l"], {
        env: { ...process.env, SSH_AUTH_SOCK: agentSock },
        encoding: "utf8",
      });
      // ssh-add spells fingerprints in the standard base64 alphabet; the
      // wire spelling is base64url. Normalize before comparing sets.
      const norm = (fp: string): string => fp.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const agentFps = addList.stdout
        .split("\n")
        .map((line) => line.match(/SHA256:(\S+)/)?.[1])
        .filter((x): x is string => x !== undefined)
        .map((x) => `SHA256:${norm(x)}`);
      expect(agentFps.sort(), "[stage 0] the real ssh-agent holds exactly the two fixture keys").toEqual(
        [fpA, fpA2].sort(),
      );

      // ── The backend with the capture preload, the admin, the two machines.
      const inst = await startRelayBackend(
        `#!/bin/bash\nexec ${JSON.stringify(bunBin)} ${JSON.stringify(nodeMainTs)} "$@"\n`,
      );
      cleanup("backend", () => stopRelayBackend());

      admin = await freshCtx(playwright);
      cleanup("admin ctx", async () => {
        await admin?.dispose();
      });
      // The const alias the closures use: `let admin` never narrows across a
      // closure, so every stage after sign-up talks to `api` (spec 22's rule).
      const api = admin;
      const signUp = await admin.post("/api/auth/sign-up/email", { data: ADMIN });
      expect(signUp.ok(), `[stage 0] admin sign-up: ${await signUp.text()}`).toBe(true);

      const startMachine = async (
        name: string,
        _home: string,
        extraEnv: Record<string, string | undefined>,
      ): Promise<{ id: string; dataDir: string }> => {
        const mint = await api.post("/api/nodes/setup-keys");
        expect(mint.status(), `[stage 0] mint setup key for ${name}`).toBe(201);
        const setupKey = ((await mint.json()) as { key: string }).key;
        const homeDir = path.join(root, `${name}-state`);
        const dataDir = path.join(root, `${name}-data`);
        const tmuxBase = path.join(root, `${name}-tmux`);
        mkdirSync(homeDir, { recursive: true });
        mkdirSync(tmuxBase, { recursive: true });
        cleanup(`tmux ${name}`, () => sweepTmux(tmuxBase));
        const h = await startNode({
          home: homeDir,
          dataDir,
          tmuxBase,
          setupKey,
          name,
          server: ORIGIN,
          // Bun derives userInfo().username from these env vars. Containers
          // can omit them, making the resolver report "unknown" while sshd
          // authenticates the real uid. Keep the fixture account consistent.
          env: { USER: D.user, LOGNAME: D.user, ...extraEnv },
        });
        cleanup(`node ${name}`, async () => {
          await h.stop();
        });
        await pollUntil(
          `[stage 0] node ${name} never came online`,
          async () => {
            const res = await api.get("/api/nodes");
            if (!res.ok()) return false;
            const listed = (await res.json()) as { nodes: { name: string; status: string }[] };
            return listed.nodes.some((n) => n.name === name && n.status === "online");
          },
          READY_TIMEOUT,
        );
        const nodes = (
          (await (await api.get("/api/nodes")).json()) as {
            nodes: { id: string; name: string }[];
          }
        ).nodes;
        const id = nodes.find((n) => n.name === name)?.id;
        if (id === undefined) throw new Error(`[stage 0] node ${name} row vanished`);
        const enable = await api.put(`/api/nodes/${id}/ssh-enabled`, { data: { on: true } });
        expect(enable.ok(), `[stage 0] enable ssh on ${name}: ${await enable.text()}`).toBe(true);
        return { id, dataDir };
      };

      const [A, B] = [
        await startMachine("relay-A-keyhome", D.homeA, { HOME: D.homeA, SSH_AUTH_SOCK: agentSock }),
        await startMachine("relay-B-nobody", D.homeB, {
          HOME: D.homeB,
          SSH_AUTH_SOCK: undefined,
          SSH_AGENT_PID: undefined,
        }),
      ];

      // "B holds none", stated as disk facts, before any pane exists.
      expect(readdirSafe(path.join(D.homeB, ".ssh")).sort(), "B's .ssh holds only the alias config").toEqual([
        "config",
      ]);
      expect(readdirSafe(path.join(B.dataDir)), "B's data dir starts key-free").not.toContain("keyA");

      stage("stage 0 done");
      // ── Stage 1: the roster comes from the REAL agent (SSH2_AGENTC_REQUEST_
      // IDENTITIES 11 answered 12 through the signed ssh_agent_identities
      // command), with blobs withheld and the agent's OWN comments attached.
      const roster = await admin.get(`/api/ssh/identities?node=${A.id}`);
      expect(roster.ok(), `[stage 1] roster: ${await roster.text()}`).toBe(true);
      const identities = ((await roster.json()) as { identities: { fingerprint: string; comment: string }[] })
        .identities;
      expect(
        identities.map((i) => i.fingerprint).sort(),
        "the roster is exactly the real agent's two identities",
      ).toEqual([fpA, fpA2].sort());
      const comments = identities.map((i) => i.comment).sort();
      expect(comments, "the roster comments are the agent's own (the fixture's distinct -C labels)").toEqual(
        [D.keyAComment, D.keyA2Comment].sort(),
      );

      stage("stage 1 roster ok");
      // Stage 2: relay authorization is existing launch access, with an explicit key choice.
      stage("stage 2 launch access and roster ready");
      // ── Stage 3: the relay launch. The pane is B's ssh with NO key of its
      // own, pointed at B's proxy socket.
      const launch = await admin.post("/api/ssh/launch", {
        data: {
          node: B.id,
          destination: SSH_FIXTURE_ALIAS,
          name: `e2e-relay-pane-${nonce}`,
          keyHome: A.id,
          fingerprints: [fpA],
        },
      });
      expect(launch.status(), `[stage 3] relay launch: ${await launch.text()}`).toBe(201);
      const paneId = ((await launch.json()) as { subshell: { id: string } }).subshell.id;
      paneIds.push(paneId);

      const sshDir = path.join(B.dataDir, "ssh", paneId);
      const configPath = path.join(sshDir, "config");
      const sockPath = path.join(sshDir, "agent.sock");
      const pinPath = path.join(sshDir, "known_hosts");
      await pollUntil(`[stage 3] the relay proxy socket never bound at ${sockPath}`, () => existsSync(sockPath));
      await pollUntil(`[stage 3] the rendered config never appeared at ${configPath}`, () => existsSync(configPath));
      expect(modeOf(sockPath), "the agent proxy socket is 0600").toBe(0o600);
      expect(modeOf(configPath), "the rendered config is 0600").toBe(0o600);
      expect(modeOf(pinPath), "the pinned trust file is 0600").toBe(0o600);
      const rendered = readFileSync(configPath, "utf8");
      expect(rendered).toContain("StrictHostKeyChecking yes");
      expect(rendered).toContain("GlobalKnownHostsFile /dev/null");
      expect(rendered).toContain("UserKnownHostsFile");
      expect(readFileSync(pinPath, "utf8")).toContain(`[127.0.0.1]:${D.port} ssh-ed25519 `);

      stage("stage 3 pane+files");
      // ── Stage 4: the numbering arbiter. RAW 10.x requests over B's proxy
      // socket, answered by the REAL agent on A (well inside the 30 s
      // handshake-window lifetime cap).
      const blobA = pubBlob(`${D.keyA}.pub`);
      const blobA2 = pubBlob(`${D.keyA2}.pub`);
      const filtered = await pollUntilResult(
        `[stage 4] the raw identities request never answered a filtered 10.x roster`,
        async () => {
          try {
            const ans = await agentRoundTrip(sockPath, Buffer.from([TEN_X.identities]));
            return ans[0] === TEN_X.answer ? ans : null;
          } catch {
            return null;
          }
        },
      );
      const rosterViaProxy = parseIdentitiesAnswer(filtered);
      expect(rosterViaProxy, "the relayed roster is scoped to the selected keys: exactly the granted key").toHaveLength(
        1,
      );
      expect(rosterViaProxy[0]?.blob.equals(blobA), "the relayed roster carries A's granted blob").toBe(true);
      expect(rosterViaProxy[0]?.comment, "the scoped entry carries the agent's own comment").toBe(D.keyAComment);
      expect(fingerprint(rosterViaProxy[0]?.blob as Buffer)).toBe(fpA);

      const signData = Buffer.from(`e2e-relay-sign-${nonce}`);
      const signed = await agentRoundTrip(sockPath, buildSignRequest(blobA, signData, true));
      assertValidSignature(signed, blobA, signData); // a REAL signature from the REAL agent, through the relay

      const classicBody = await agentRoundTrip(sockPath, buildSignRequest(blobA, signData, false));
      assertValidSignature(classicBody, blobA, signData); // the classic body shape is legal under 10.x too

      const ungranted = await agentRoundTrip(sockPath, buildSignRequest(blobA2, Buffer.from("nope"), true));
      expect(ungranted[0], "a SIGN_REQUEST outside the selected key set never reaches the agent").toBe(AGENT_FAILURE);

      // The colliding bytes, refused under the RESOLVED scheme without ever
      // touching the agent (the ruling's whole point): classic-13-as-roster
      // (a body-less 13 is a truncated sign), classic-15, SSH1-era 0/1, and
      // the mutation/extension codes 17/18/27.
      for (const [label, payload] of [
        ["classic identities (byte 13, no body)", Buffer.from([13])],
        ["classic sign (byte 15)", Buffer.from([15])],
        ["SSH1 identities (byte 0)", Buffer.from([0])],
        ["SSH1 sign (byte 1)", Buffer.from([1])],
        ["ADD_IDENTITY (byte 17)", Buffer.concat([Buffer.from([17]), sshStr(blobA), sshStr("x")])],
        ["REMOVE_ALL_IDENTITIES (byte 18)", Buffer.from([18])],
        ["EXTENSION_REQUEST (byte 27)", Buffer.concat([Buffer.from([27]), sshStr("no-ext@subshell.test")])],
      ] as const) {
        const ans = await agentRoundTrip(sockPath, payload as Buffer);
        expect(ans[0], `${label} is refused by the default-deny allow-list, not forwarded`).toBe(AGENT_FAILURE);
      }

      stage("stage 4 wire arbiter");
      // ── Stage 5: the ssh handshake itself completes over the relay: sshd's
      // own VERBOSE log accepted A's key; the REMOTE shell evaluates the marker.
      const daemonLog = D.d.logPath;
      const countMatches = (re: RegExp): number =>
        (readFileSync(daemonLog, "utf8").match(new RegExp(re.source, "g")) ?? []).length;
      // Match ANY accepted line by fingerprint rather than a delta over a
      // baseline count: the pane's connect can land during the launch poll,
      // before stage 5 runs, so a "grew by one" test would wait forever on a
      // second accept. The fixture's own readiness probe fails key auth on a
      // "Failed publickey" line, so an accepted-line match is exact. The
      // fingerprint sshd names MUST be A's - the key B does not hold.
      let acceptedLine = "";
      await pollUntil(
        () =>
          `[stage 5] sshd never accepted a publickey through the relay; log ends: ${readFileSync(daemonLog, "utf8").slice(-1200)}`,
        () => {
          const lines = readFileSync(daemonLog, "utf8")
            .split("\n")
            .filter((l) => l.includes("Accepted publickey"));
          acceptedLine = lines.at(-1) ?? "";
          return lines.length > 0;
        },
      );
      const acceptedRaw = acceptedLine.match(/SHA256:([A-Za-z0-9+/=]+)/)?.[1] ?? "(no fingerprint in log line)";
      expect(`SHA256:${norm(acceptedRaw)}`, `[stage 5] sshd accepted exactly A's key; line: ${acceptedLine}`).toBe(fpA);
      await pollUntil(
        () => `[stage 5] sshd never started a shell; log ends: ${readFileSync(daemonLog, "utf8").slice(-1200)}`,
        () => countMatches(/Starting session: shell/g) > 0,
      );
      await sleep(1_500); // the remote shell's init before its line editor exists (spec 22's rule)
      const typed = `echo SSH-RELAY-$((20+2))-OK`;
      const input = await admin.post(`/api/subshells/${paneId}/input`, { data: { text: typed } });
      expect(input.ok(), `[stage 5] owner input: ${await input.text()}`).toBe(true);
      let lastLog = "";
      await pollUntil(
        () =>
          `[stage 5] the relayed session never echoed the remote marker; last log: ${JSON.stringify(lastLog.slice(-600))}`,
        async () => {
          const res = await api.get(`/api/subshells/${paneId}/log`);
          if (!res.ok()) {
            lastLog = `HTTP ${res.status()}`;
            return false;
          }
          lastLog = ((await res.json()) as { lines: string[] }).lines.join("\n");
          return lastLog.includes("SSH-RELAY-22-OK");
        },
      );
      // The whole path is now proven real: bytes travelled B -> plane -> A ->
      // plane -> D and back, and the only key in play never left A's agent.

      stage("stage 5 remote marker");
      // ── Stage 5.5: the §5.6 hard lifetime cap. The handshake window closes
      // at SSH_RELAY_LIFETIME_MS no matter how healthy the session is: the
      // plane names the cut, B unbinds the proxy socket with it, and the
      // ESTABLISHED pane keeps its shell (the agent is owed nothing after
      // auth). Waiting out the 30 s cap is the deterministic form.
      const capWaitStart = Date.now();
      await pollUntil(
        () => `[stage 5.5] the proxy socket outlived the relay lifetime cap (${Date.now() - capWaitStart} ms waited)`,
        () => !existsSync(sockPath),
        CAPTURE_TIMEOUT,
      );
      await pollUntil(`[stage 5.5] the plane never audited the lifetime-expiry close`, async () => {
        const res = await api.get("/api/audit?limit=300");
        if (!res.ok()) return false;
        const rows = (await res.json()) as { action: string; metadata: { reason?: string; paneId?: string } | null }[];
        return rows.some(
          (r) =>
            r.action === "node.ssh_relay.close" &&
            r.metadata?.reason === "lifetime-expiry" &&
            r.metadata?.paneId === paneId,
        );
      });
      expect(lastLog, "the pane's established shell survived the relay's window").toContain("SSH-RELAY-22-OK");

      stage("stage 5.5 lifetime cap");
      // ── Stage 6: the plane-side capture: opaque envelopes + routing ids
      // only. Key material, signatures, agent bytes, fingerprints, and typed
      // text appear nowhere in what the plane recorded.
      const frames = await pollUntilResult(
        `[stage 6] the capture never carried a B2A and an A2B frame`,
        async () => {
          const f = readCapture(inst.captureFile);
          return f.some((x) => x.frame.direction === "B2A") && f.some((x) => x.frame.direction === "A2B") ? f : null;
        },
        15_000,
      );
      const captureText = readFileSync(inst.captureFile, "utf8");
      for (const f of frames) {
        expect(f.frame.type).toBe("relay");
        expect(f.frame.ref).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        let blobJson: Record<string, unknown>;
        try {
          blobJson = JSON.parse(Buffer.from(f.frame.blob, "base64").toString("utf8")) as Record<string, unknown>;
        } catch {
          throw new Error(`[stage 6] a captured blob is not base64 of a JWE JSON: ${f.frame.blob.slice(0, 80)}`);
        }
        for (const field of ["ciphertext", "iv", "tag", "protected"]) {
          expect(typeof blobJson[field], `[stage 6] envelope field ${field}`).toBe("string");
        }
        expect((blobJson.ciphertext as string).length, "ciphertext is not empty").toBeGreaterThan(0);
      }
      const secretMarkers: [string, string][] = [
        ["A's private key", readFileSync(D.keyA, "utf8")],
        ["A's public blob (base64)", readFileSync(`${D.keyA}.pub`, "utf8").trim().split(" ")[1] as string],
        ["the granted fingerprint", fpA.slice(7)],
        ["the ungranted fingerprint", fpA2.slice(7)],
        ["the signed data", `e2e-relay-sign-${nonce}`],
        ["the typed remote command", "SSH-RELAY-$((20+2))-OK"],
        ["the agent request byte stream marker", "ssh-ed25519"],
      ];
      for (const [what, needle] of secretMarkers) {
        expect(captureText.includes(needle), `[stage 6] the capture must not carry ${what}`).toBe(false);
      }
      expect(frames.length, "handshake traffic crossed the plane (frames recorded)").toBeGreaterThanOrEqual(2);

      stage("stage 6 capture opaque");
      // ── Stage 7: "Set up Subshell here" (§7) through the REAL install
      // pipeline. D egresses to this plane, installs the (wrapper) node
      // binary, enrolls with a fresh key the pane must never see - and, with
      // --no-service, the test itself starts the daemon it enrolled, which is
      // what makes the act's success the node's `ready` frame.
      //
      // PREFLIGHT first, and it is load-bearing, not decoration: the whole
      // leg is sandboxed by sshd `SetEnv` lines pointing the session's config
      // home and install dir at scratch paths. If SetEnv ever stops reaching
      // the session (an sshd change, a config-write regression), the REAL
      // installer would run against THIS account's real home. The probe reads
      // the exact three facts back over a direct keyA session before anything
      // can install; a mismatch refuses the stage instead of polluting the
      // machine. (Measured: the first version of this fixture declared the
      // option and never wrote the lines - the act then really did install
      // into the developer's home, which is why this probe exists.)
      const envProbe = spawnSync(
        "ssh",
        [
          "-F",
          "/dev/null",
          "-i",
          D.keyA,
          "-p",
          String(D.port),
          "-o",
          "BatchMode=yes",
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "ConnectTimeout=5",
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
          `${D.user}@127.0.0.1`,
          'printf "%s|%s|%s" "$SUBSHELL_DATA_DIR" "$SUBSHELL_CONFIG_HOME" "$SUBSHELL_NO_SERVICE"',
        ],
        { encoding: "utf8", env: { ...process.env, SSH_AUTH_SOCK: agentSock } },
      );
      expect(
        envProbe.stdout,
        `[stage 7] the SetEnv sandbox must reach D's session before any install (probe: ${envProbe.stdout}, stderr: ${envProbe.stderr.slice(-300)})`,
      ).toBe(`${dnode}|${dconf}|1`);

      const actState: { done: boolean; ok: boolean; body: string } = { done: false, ok: false, body: "" };
      const setupPromise = admin.post("/api/ssh/setup-here", { data: { paneId } }).then(async (res) => {
        actState.done = true;
        actState.ok = res.ok();
        actState.body = await res.text();
        return res;
      });
      const watcher: Promise<void> = (async (): Promise<void> => {
        const configJson = path.join(dconf, "config.json");
        let lastSize = -1;
        let stable = 0;
        const deadline = Date.now() + 500_000;
        for (;;) {
          if (existsSync(configJson)) {
            const size = statSync(configJson).size;
            if (size > 0 && size === lastSize) {
              stable += 1;
              if (stable >= 2) break;
            } else {
              lastSize = size;
              stable = 0;
            }
          }
          if (actState.done && !actState.ok) {
            throw new Error(`[stage 7] the act refused before D enrolled: ${actState.body.slice(0, 500)}`);
          }
          if (Date.now() > deadline) {
            throw new Error(
              `[stage 7] the install never wrote D's config at ${configJson} (act done=${String(actState.done)} ok=${String(actState.ok)})`,
            );
          }
          await sleep(300);
        }
        // The enrolled-but-unstarted daemon: `setup --no-service` deliberately
        // installs no service, so the test starts the binary ITSELF. Same OS
        // user, same host, scratch config home + data dir from config.json -
        // this is exactly the `subshell run` the act's success waits for.
        const child = spawn(path.join(dnode, "subshell"), ["run"], {
          detached: true,
          stdio: "ignore",
          env: (() => {
            const dEnv: NodeJS.ProcessEnv = {
              ...process.env,
              SUBSHELL_CONFIG_HOME: dconf,
              SUBSHELL_DATA_DIR: dnode,
              TMUX_TMPDIR: dTmux,
            };
            delete dEnv.SSH_AUTH_SOCK;
            delete dEnv.TMUX;
            delete dEnv.TMUX_PANE;
            return dEnv;
          })(),
        });
        child.unref();
        dDaemonPid = child.pid;
      })();
      cleanup("D daemon", () => {
        if (dDaemonPid !== undefined) killGroup(dDaemonPid, "SIGTERM");
        sweepTmux(dTmux);
      });
      let setup;
      try {
        setup = await setupPromise;
      } catch (err) {
        const why = await watcher.then(
          () => "watcher completed",
          (e) => String(e),
        );
        throw new Error(`[stage 7] the act call threw: ${String(err)}\n--- watcher: ${why}`);
      }
      if (!setup.ok()) {
        const why = await watcher.then(
          () => "(watcher completed)",
          (e) => String(e),
        );
        throw new Error(`[stage 7] set up Subshell here refused: ${await setup.text()}\n--- watcher: ${why}`);
      }
      await watcher.catch((err: unknown) => {
        /* the act already returned ok; the daemon fact is asserted through the node row */
        leaks.push(`stage 7 watcher after ok act: ${String(err)}`);
      });
      const newNodeId = ((await setup.json()) as { nodeId: string }).nodeId;
      const nodesNow = (
        (await (await admin.get("/api/nodes")).json()) as {
          nodes: { id: string; name: string; status: string }[];
        }
      ).nodes;
      const dRow = nodesNow.find((n) => n.id === newNodeId);
      expect(dRow, `[stage 7] the enrolled node row: ${JSON.stringify(nodesNow)}`).toBeDefined();
      expect(dRow?.status, "D enrolled AND reported ready (the act's success fact)").toBe("online");
      // The key's real-run redaction proof: neither the minted setup key nor
      // the install URL ever entered B's pane log (the act ran on its own
      // ssh exec, never in the pane).
      const setupLogRes = await admin.get(`/api/subshells/${paneId}/log`);
      expect(setupLogRes.ok()).toBe(true);
      const setupLog = ((await setupLogRes.json()) as { lines: string[] }).lines.join("\n");
      expect(setupLog, "the setup key never entered the pane log").not.toMatch(/nsk_[A-Za-z0-9_-]{32}/);
      expect(setupLog).not.toContain("setup_key=");
      // And not into B's on-disk copy either (the pipe-pane file is the
      // source the log route strips; check the raw bytes too).
      try {
        const rawPane = readFileSync(path.join(B.dataDir, "subshells", `${paneId}.log`), "utf8");
        expect(rawPane, "the raw pane capture also never saw the key").not.toMatch(/nsk_[A-Za-z0-9_-]{32}/);
      } catch {
        /* the raw file lives on the node's dir only when B is this machine -
           it is, but a raced unlink must not cost the assertion above */
      }

      stage("stage 7 D enrolled");
      // ── Stage 8: launch-share revoke between the relay handshake and D. The
      // destination is the never-answers listener: the pane's ssh sits in the
      // banner wait, so the relay is still the ONLY thing that could ever
      // sign, and the revoke lands strictly BEFORE any D-side auth.
      const memberEmail = `relay-member-${nonce}@subshell.test`;
      const memberPassword = "e2e-relay-member-pass-1";
      const createdMember = await admin.post("/api/users", {
        data: { email: memberEmail, name: memberEmail, password: memberPassword, role: "user" },
      });
      expect(createdMember.ok(), await createdMember.text()).toBe(true);
      const memberId = ((await createdMember.json()) as { id: string }).id;
      const member = await freshCtx(playwright);
      cleanup("member ctx", () => member.dispose());
      expect(
        (await member.post("/api/auth/sign-in/email", { data: { email: memberEmail, password: memberPassword } })).ok(),
      ).toBe(true);
      for (const nodeId of [A.id, B.id]) {
        expect(
          (
            await admin.put(`/api/nodes/${nodeId}/shares`, {
              data: { shares: [{ granteeUserId: memberId, permission: "view" }] },
            })
          ).ok(),
        ).toBe(true);
      }
      const hangLaunch = await member.post("/api/ssh/launch", {
        data: {
          node: B.id,
          destination: RELAY_HANG_ALIAS,
          name: `e2e-relay-hang-${nonce}`,
          keyHome: A.id,
          fingerprints: [fpA],
        },
      });
      expect(hangLaunch.status(), `[stage 8] hang-pane launch: ${await hangLaunch.text()}`).toBe(201);
      const hangPaneId = ((await hangLaunch.json()) as { subshell: { id: string } }).subshell.id;
      paneIds.push(hangPaneId);
      const hangSock = path.join(B.dataDir, "ssh", hangPaneId, "agent.sock");
      await pollUntil(`[stage 8] the hang pane's proxy socket never bound`, () => existsSync(hangSock));
      const preRevoke = await agentRoundTrip(hangSock, Buffer.from([TEN_X.identities]));
      expect(preRevoke[0], "[stage 8] signing works while launch access stands").toBe(TEN_X.answer);

      const revoke = await admin.put(`/api/nodes/${A.id}/shares`, { data: { shares: [] } });
      expect(revoke.ok(), `[stage 8] revoke: ${await revoke.text()}`).toBe(true);
      await pollUntil(
        `[stage 8] the proxy socket outlived launch access (signing did not stop)`,
        () => !existsSync(hangSock),
      );
      const refused = await agentRoundTrip(hangSock, Buffer.from([TEN_X.identities])).then(
        () => "answered",
        (err: unknown) => String((err as NodeJS.ErrnoException).code ?? err),
      );
      expect(
        refused === "answered" ? "ANSWERED - SIGNING DID NOT STOP" : refused,
        "[stage 8] after revoke the agent socket is gone; nothing can sign toward D",
      ).toMatch(/ENOENT|ECONNREFUSED/);
      await pollUntil(`[stage 8] the plane never audited the access-revoked close`, async () => {
        const res = await api.get("/api/audit?limit=300");
        if (!res.ok()) return false;
        const rows = (await res.json()) as { action: string; metadata: { reason?: string; paneId?: string } | null }[];
        return rows.some(
          (r) =>
            r.action === "node.ssh_relay.close" &&
            r.metadata?.reason === "access-revoked" &&
            r.metadata?.paneId === hangPaneId,
        );
      });
      await retire(member, hangPaneId);

      stage("stage 8 revoke cut");
      // ── Stage 9: a CHANGED D host key is the hard block, and TOFU recovery
      // is delete + fresh capture (the operator re-trusting D on A).
      const { knownHostsLine } = await D.rotateHostKey();
      // Admin launch access survives a member's revocation. The stored pin still
      // checks the destination against its old key until explicitly reset.
      const changedLaunch = await admin.post("/api/ssh/launch", {
        data: {
          node: B.id,
          destination: SSH_FIXTURE_ALIAS,
          name: `e2e-relay-blocked-${nonce}`,
          keyHome: A.id,
          fingerprints: [fpA],
        },
      });
      expect(
        changedLaunch.status(),
        `[stage 9] changed-key launch opens the pane (the block is at the pin): ${await changedLaunch.text()}`,
      ).toBe(201);
      const blockedPaneId = ((await changedLaunch.json()) as { subshell: { id: string } }).subshell.id;
      paneIds.push(blockedPaneId);
      let blockedLog = "";
      await pollUntil(
        () => `[stage 9] the changed host key never blocked the pane; log: ${JSON.stringify(blockedLog.slice(-800))}`,
        async () => {
          const res = await api.get(`/api/subshells/${blockedPaneId}/log`);
          if (res.ok()) blockedLog = ((await res.json()) as { lines: string[] }).lines.join("\n");
          return /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/.test(blockedLog);
        },
      );
      await retire(admin, blockedPaneId);

      // Recovery: the operator deletes the pin, A re-trusts D, the next
      // launch captures the fresh TOFU record, and the marker flows again.
      const delPin = await admin.delete(`/api/ssh/host-pins/${encodeURIComponent(`127.0.0.1:${D.port}`)}`);
      expect(delPin.ok(), `[stage 9] delete pin: ${await delPin.text()}`).toBe(true);
      D.setKnownHostsLineD(knownHostsLine);
      const recovered = await admin.post("/api/ssh/launch", {
        data: {
          node: B.id,
          destination: SSH_FIXTURE_ALIAS,
          name: `e2e-relay-recovered-${nonce}`,
          keyHome: A.id,
          fingerprints: [fpA],
        },
      });
      expect(recovered.status(), `[stage 9] recovery launch: ${await recovered.text()}`).toBe(201);
      const recPaneId = ((await recovered.json()) as { subshell: { id: string } }).subshell.id;
      paneIds.push(recPaneId);
      const shellBefore = countMatches(/Starting session: shell/g);
      await pollUntil(
        () =>
          `[stage 9] TOFU recovery never reached a remote shell; log ends: ${readFileSync(daemonLog, "utf8").slice(-1200)}`,
        () => countMatches(/Starting session: shell/g) > shellBefore,
      );
      await sleep(1_500);
      const typed2 = `echo SSH-RELAY2-$((40+2))-OK`;
      const input2 = await admin.post(`/api/subshells/${recPaneId}/input`, { data: { text: typed2 } });
      expect(input2.ok(), `[stage 9] recovery input: ${await input2.text()}`).toBe(true);
      let recLog = "";
      await pollUntil(
        () =>
          `[stage 9] the recovered session never echoed the marker; last log: ${JSON.stringify(recLog.slice(-600))}`,
        async () => {
          const res = await api.get(`/api/subshells/${recPaneId}/log`);
          if (!res.ok()) return false;
          recLog = ((await res.json()) as { lines: string[] }).lines.join("\n");
          return recLog.includes("SSH-RELAY2-42-OK");
        },
      );
      // One more honest capture sweep after the whole story: the rotated host
      // key's bytes never entered the plane's record either.
      const rotatedPub = readFileSync(path.join(root, "hostkey.pub"), "utf8").trim().split(" ")[1] as string;
      expect(
        readFileSync(inst.captureFile, "utf8").includes(rotatedPub),
        "D's host key material never appeared on the plane's capture",
      ).toBe(false);
      stage("stage 9 TOFU recovered");
    } finally {
      // Every stage's resource goes, whatever the story did half-way. Rows
      // first (the admin ctx still answers), then daemons, then fixture.
      if (admin) {
        for (const paneId of paneIds) {
          try {
            await retire(admin, paneId);
          } catch (err) {
            leaks.push(`retire ${paneId}: ${String(err)}`);
          }
        }
      }
      for (const { name, run } of cleanupFns.reverse()) {
        try {
          await run();
        } catch (err) {
          leaks.push(`${name}: ${String(err)}`);
        }
      }
      if (leaks.length > 0) console.error(`[23-ssh-relay] cleanup problems: ${leaks.join("; ")}`);
    }
  });
});

/** Retire one pane row: terminate (a dead or hung ssh child still accepts it) then delete. */
async function retire(admin: APIRequestContext | undefined, paneId: string): Promise<void> {
  if (!admin) return;
  try {
    await admin.post(`/api/subshells/${paneId}/terminate`);
  } catch {
    /* the instance may already be down; the group kills are the real backstop */
  }
  try {
    await admin.delete(`/api/subshells/${paneId}`);
  } catch {
    /* as above */
  }
}
