import type { RestoreConfigOverrides } from "@/modules/backups/types.js";
export interface RestoreOpts {
  archive?: string;
  staged?: string;
  listStaged?: boolean;
  discardStaged?: string;
  prepare?: boolean;
  inspect?: boolean;
  nativePreflight?: boolean;
  native?: boolean;
  json?: boolean;
  mode?: "same-machine" | "migration";
  dataDir?: string;
  databasePath?: string;
  configDir?: string;
  configOverrides?: RestoreConfigOverrides;
  recoverAdmin?: string;
  temporaryPasswordFile?: string;
  passwordFile?: string;
  start?: boolean;
  yes?: boolean;
  force?: boolean;
}
