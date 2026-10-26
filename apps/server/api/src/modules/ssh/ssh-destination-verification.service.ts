import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import { isSshKnownHostsPinLine } from "@internal/subshell-protocol";
import { SshRpcError, sshHostKey } from "@/modules/nodes/ssh-rpc.js";
import { gateSshNode } from "@/modules/ssh/policy.js";
import { sshCanonicalDestination, sshExpectedDestinationProblem } from "@/modules/ssh/ssh-destination.js";
import {
  captureHostPin,
  hostKeyFingerprints,
  hostPinFor,
  hostPinRefusal,
  SshHostPinError,
} from "@/modules/ssh/ssh-host-pins.service.js";
import { type SshRefusal, sshResolveDestination } from "@/modules/ssh/ssh-launch.service.js";

interface Request {
  viewerId: string;
  node: string;
  keyHome: string;
  destination: string;
  expectedDestination?: string;
}
interface Challenge extends Request {
  canonical: string;
  line: string;
  expires: number;
}
// Short-lived, bounded, account-scoped challenges keep raw trust material out of form submissions.
const challenges = new Map<string, Challenge>();
const TTL = 5 * 60_000;
const defaultDeps = { gate: gateSshNode, resolve: sshResolveDestination, hostKey: sshHostKey, now: Date.now };
let deps = defaultDeps;

/** Isolate time and node RPCs in tests; trust storage and permission decisions remain explicit. */
export function setDestinationVerificationDepsForTests(overrides: Partial<typeof defaultDeps> | null) {
  challenges.clear();
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}
function refuse(refusal: SshRefusal): never {
  if ("code" in refusal) throwApiError({ code: refusal.code, message: refusal.message, doNotLog: true });
  fail("This destination’s SSH configuration isn’t supported. Check the connecting node’s settings.");
}
function fail(message: string): never {
  throwApiError({ code: BackendErrorCodes.SSH_HOST_PIN_MISSING, message, doNotLog: true });
}
async function resolve(request: Request) {
  const keyGate = await deps.gate(request.viewerId, request.keyHome);
  if (!keyGate.ok) refuse(keyGate.refusal);
  const answer = await deps.resolve(request.viewerId, request.node, request.destination, request.expectedDestination);
  if (!answer.ok) refuse(answer.refusal);
  if (!answer.value.accepted)
    fail("This destination’s SSH configuration isn’t supported. Check the connecting node’s settings.");
  const snapshot = answer.value.snapshot;
  const problem = sshExpectedDestinationProblem(snapshot, request.expectedDestination);
  if (problem) throwApiError({ code: BackendErrorCodes.CONFIG_INVALID, message: problem, doNotLog: true });
  // A direct scan cannot follow jump routes or emulate HostKeyAlias. Never scan a different path silently.
  if (snapshot.proxyJumps.length || snapshot.hostKeyAlias)
    fail(
      "Subshell can’t verify this destination automatically through its SSH configuration. Ask the node’s owner to verify it.",
    );
  return {
    snapshot,
    canonical: sshCanonicalDestination({ host: snapshot.host, port: snapshot.port, user: snapshot.user }),
  };
}

/** Discover an unfamiliar destination without saving trust or attempting authentication. */
export async function prepareDestinationVerification(request: Request) {
  for (const [token, challenge] of challenges) {
    if (challenge.expires <= deps.now()) challenges.delete(token);
  }
  const { snapshot, canonical } = await resolve(request);
  const existing = await hostPinFor({ ownerUserId: request.viewerId, destination: canonical });
  if (existing)
    fail(
      "This destination already has a saved identity. Retry the connection. If its identity has changed, ask its administrator to verify the change.",
    );
  let lines: string[];
  try {
    // Conflicting recorded trust must not be treated as an unfamiliar destination.
    const known = await deps.hostKey(request.keyHome, {
      host: snapshot.host,
      port: snapshot.port,
      user: snapshot.user,
    });
    if (known.lines.length)
      fail(
        "The node supplying your keys already has a saved identity for this destination. Ask its owner to check the saved identities before trying again.",
      );
    lines = (
      await deps.hostKey(request.node, { host: snapshot.host, port: snapshot.port, user: snapshot.user, scan: true })
    ).lines;
  } catch (error) {
    if (error instanceof SshRpcError)
      fail("Couldn’t retrieve the destination’s identity. Check that the connecting node can reach it and try again.");
    throw error;
  }
  // Prefer Ed25519, then ECDSA, then RSA. OpenSSH prioritizes the saved key during negotiation.
  const line = [...lines]
    .sort((a, b) => rank(a) - rank(b))
    .find((entry) => isSshKnownHostsPinLine(entry) && hostKeyFingerprints(entry).length === 1);
  if (!line) fail("The destination didn’t provide a supported SSH identity. Ask its administrator to check SSH.");
  if (
    challenges.size >= 1000 ||
    [...challenges.values()].filter((entry) => entry.viewerId === request.viewerId).length >= 5
  )
    fail("Too many destination checks are waiting. Try again shortly.");
  const token = crypto.randomUUID();
  challenges.set(token, { ...request, canonical, line, expires: deps.now() + TTL });
  return {
    token,
    destination: canonical,
    fingerprint: (hostKeyFingerprints(line)[0] as string).replace(/-/g, "+").replace(/_/g, "/"),
  };
}

function rank(line: string) {
  const type = line.split(/\s+/)[1] ?? "";
  return type === "ssh-ed25519" ? 0 : type.startsWith("ecdsa-") ? 1 : 2;
}

/** Save only the identity shown to this viewer, after checking current access and resolution again. */
export async function acceptDestinationVerification(viewerId: string, token: string) {
  const challenge = challenges.get(token);
  if (!challenge || challenge.viewerId !== viewerId || challenge.expires <= deps.now())
    fail("This destination check has expired. Start the connection again.");
  challenges.delete(token);
  const { canonical } = await resolve(challenge);
  if (canonical !== challenge.canonical)
    fail("The destination changed while you were checking it. Start the connection again.");
  try {
    // captureHostPin never replaces an existing, different key, including concurrent confirmations.
    await captureHostPin({ ownerUserId: viewerId, aNodeId: null, destination: canonical, hostKeyLine: challenge.line });
  } catch (error) {
    if (error instanceof SshHostPinError) refuse(hostPinRefusal(error));
    throw error;
  }
  return { accepted: true as const };
}
