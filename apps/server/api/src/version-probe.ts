import { spawnSync } from "bun";

const _proc: ReturnType<typeof spawnSync> = undefined as unknown as ReturnType<typeof spawnSync>;
console.log(typeof spawnSync);
