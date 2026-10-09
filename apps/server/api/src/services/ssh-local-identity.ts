import { createPrivateKey, createPublicKey } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RelayMachineIdentity } from "@internal/pane-runtime";
import { bytesOfJwk } from "@internal/subshell-protocol";
import { exportJWK, generateKeyPair } from "jose";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import { IdentitiesRepository } from "@/db/repositories/identities.repository.js";

/** Dedicated relay identity and machine trust directory, separate from command signing and pane identities. */
export function localRelayIdentityDir(): string {
  return join(SUBSHELL_SERVER_DATA_DIR, "ssh-relay");
}

/** Validate both public/private pairs, retaining the exact public JWK strings peers pin. */
function validatedIdentity(value: unknown): RelayMachineIdentity {
  if (!value || typeof value !== "object") throw new Error("invalid identity");
  const identity = value as RelayMachineIdentity;
  for (const [publicJwk, privateJwk] of [
    [identity.publicJwk, identity.privateJwk],
    [identity.signingPublicJwk, identity.signingPrivateJwk],
  ]) {
    if (typeof publicJwk !== "string" || typeof privateJwk !== "string") throw new Error("invalid identity");
    const publicBytes = bytesOfJwk(publicJwk);
    const derived = createPublicKey(createPrivateKey({ key: JSON.parse(privateJwk), format: "jwk" })).export({
      format: "jwk",
    });
    if (!Buffer.from(publicBytes).equals(Buffer.from(bytesOfJwk(JSON.stringify(derived)))))
      throw new Error("identity pair mismatch");
  }
  return identity;
}

/** Read the dedicated file without quarantining it: subsequent calls/restarts must refuse the same corruption. */
export async function readLocalRelayIdentity(directory: string): Promise<RelayMachineIdentity> {
  try {
    return validatedIdentity(JSON.parse(await readFile(join(directory, "identity.json"), "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw err;
    throw new Error(
      "The server SSH relay identity is unreadable. Restore ssh-relay/identity.json from backup; existing identity material was not replaced.",
    );
  }
}

/** Single-flight disk creation plus immutable database registration. A rejected initialization stays rejected. */
export function createLocalRelayIdentityProvider(
  directory: string,
  register: (identity: RelayMachineIdentity) => Promise<void>,
) {
  let pending: Promise<RelayMachineIdentity> | undefined;
  return (): Promise<RelayMachineIdentity> =>
    (pending ??= (async () => {
      let identity: RelayMachineIdentity;
      try {
        identity = await readLocalRelayIdentity(directory);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
        const pair = async (alg: string) => {
          const keys = await generateKeyPair(alg, { crv: "P-256", extractable: true });
          return {
            publicJwk: JSON.stringify(await exportJWK(keys.publicKey)),
            privateJwk: JSON.stringify(await exportJWK(keys.privateKey)),
          };
        };
        const encryption = await pair("ECDH-ES");
        const signing = await pair("ES256");
        identity = { ...encryption, signingPublicJwk: signing.publicJwk, signingPrivateJwk: signing.privateJwk };
        try {
          await writeFile(join(directory, "identity.json"), JSON.stringify(identity), { mode: 0o600, flag: "wx" });
        } catch (writeError) {
          if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
          identity = await readLocalRelayIdentity(directory);
        }
      }
      await register(identity);
      return identity;
    })());
}

/** Compare-and-register prevents first-use races and never rotates either existing public half. */
export async function registerLocalRelayIdentity(identity: RelayMachineIdentity): Promise<void> {
  const repo = new IdentitiesRepository(db);
  const row = await repo.registerIfMatching({
    principalId: "node:local",
    publicKey: identity.publicJwk,
    signingPublicKey: identity.signingPublicJwk,
    displayName: null,
  });
  if (!row)
    throw new Error(
      "The server SSH relay identity differs from its registered identity. Restore its identity file or explicitly repair the server relay identity registration after verifying both fingerprints.",
    );
}

let provider: ReturnType<typeof createLocalRelayIdentityProvider> | undefined;
/** Lazy initialization: importing the server or running a CLI subcommand performs no I/O. */
export function ensureLocalRelayIdentity(): Promise<RelayMachineIdentity> {
  provider ??= createLocalRelayIdentityProvider(localRelayIdentityDir(), registerLocalRelayIdentity);
  return provider();
}
/** Re-read only after an explicit identity registration repair (or test teardown). */
export function resetLocalRelayIdentity(): void {
  provider = undefined;
}
