import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The sidecar fetch path is deliberately DUPLICATED between the two desktop
 * apps: each app's release script must run standalone (a cut shells out to
 * `bun run release:<app>` from the repo root, and a shared module under
 * scripts/ is not a package either app imports from src). Duplication with no
 * guard becomes two sources of truth the next time a digest rule or a refusal
 * changes, and the unfixed copy keeps shipping the weaker rule silently. This
 * test is the guard: the fetch path must stay identical apart from the tokens
 * that name which CLI is being fetched. A failure means a fix (or a comment)
 * landed in one copy: copy it across, or decide the drift is real and encode
 * it here deliberately.
 */

const SERVER = readFileSync(join(import.meta.dir, "../../apps/server/desktop/src/scripts/release.ts"), "utf8");
const CLIENT = readFileSync(join(import.meta.dir, "../../apps/client/desktop/src/scripts/release.ts"), "utf8");

/** The fetch path: fetchAsset's doc block through stageSidecar's closing brace. */
function fetchPath(src: string): string {
  const start = src.indexOf("async function fetchAsset(");
  if (start === -1) throw new Error("fetchAsset not found");
  const rstart = src.lastIndexOf("/**", start);
  const endAnchor = src.indexOf("The old path: BUILD");
  if (endAnchor === -1) throw new Error("stageSidecarFromSource marker not found");
  const rend = src.lastIndexOf("/**", endAnchor);
  const region = src.slice(rstart, rend);
  // An extraction that grabbed the wrong span would let the test pass
  // vacuously; the region is ~100 lines and it has to be the fetch path.
  if (!region.includes("stageSidecar") || !region.includes("SIGNED manifest"))
    throw new Error("extracted region is not the fetch path");
  return region;
}

/** The five tokens that legitimately differ, folded to one spelling. */
function normalize(region: string, side: "server" | "client"): string {
  const map: Record<string, string> =
    side === "server"
      ? {
          "cli-server": "cli-APP",
          SERVER_SIDECAR_NAME: "SIDECAR_NAME",
          serverArtifactFileName: "artifactFileName",
          "apps/server/api": "PKG_DIR",
          "staging the server sidecar for": "staging the APP sidecar for",
          "ships the CLI that was": "ships the ARTIFACT that was",
        }
      : {
          "cli-node": "cli-APP",
          NODE_SIDECAR_NAME: "SIDECAR_NAME",
          nodeArtifactFileName: "artifactFileName",
          "apps/node/agent": "PKG_DIR",
          "staging the node agent sidecar for": "staging the APP sidecar for",
          "ships the agent that was": "ships the ARTIFACT that was",
        };
  let out = region;
  for (const [from, to] of Object.entries(map)) out = out.split(from).join(to);
  return out;
}

describe("desktop release fetch paths stay one contract", () => {
  test("the extraction finds the region in both copies", () => {
    for (const src of [SERVER, CLIENT]) expect(fetchPath(src).length).toBeGreaterThan(2000);
  });

  test("the two fetch paths are identical apart from the component tokens", () => {
    const server = normalize(fetchPath(SERVER), "server");
    const client = normalize(fetchPath(CLIENT), "client");
    if (server !== client) {
      const sLines = server.split("\n");
      const cLines = client.split("\n");
      for (let i = 0; i < Math.max(sLines.length, cLines.length); i++) {
        if (sLines[i] !== cLines[i]) {
          throw new Error(
            `drift at fetch-path line ${i + 1}:\n  server: ${sLines[i] ?? "(eof)"}\n  client: ${cLines[i] ?? "(eof)"}`,
          );
        }
      }
    }
    expect(server).toBe(client);
  });
});
