import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  commandRunner,
  createDisplay,
  ExistingProbeDisplayError,
  inspectDisplay,
  ownedDisplay,
  probeName,
  removeDisplay,
  validateName,
} from "./betterdisplay.js";

const [operation, directory, executable] = process.argv.slice(2);
if (
  process.platform !== "darwin" ||
  !operation ||
  !["create", "inspect", "remove"].includes(operation) ||
  !directory ||
  !isAbsolute(directory) ||
  !executable ||
  !isAbsolute(executable) ||
  process.argv.length !== 5
) {
  console.error(
    "On macOS: bun scripts/betterdisplay-probe/index.ts create|inspect|remove /absolute/state-dir /absolute/betterdisplaycli",
  );
  process.exit(1);
}

const run = commandRunner(executable);
const journal = join(directory, "display.json");
function save(record: object): void {
  const staging = join(directory, `${randomUUID()}.tmp`);
  writeFileSync(staging, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(staging, journal);
}

try {
  if (operation === "create") {
    // Exclusive directory creation makes an existing journal a hard stop.
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
    const name = probeName(randomUUID());
    save({ name, phase: "creating" });
    try {
      const display = await createDisplay(run, name);
      save({ ...display, phase: "created" });
      console.log(JSON.stringify(display, null, 2));
    } catch (error) {
      if (error instanceof ExistingProbeDisplayError) {
        save({ name, phase: "refused" });
        throw error;
      }
      // A CLI timeout can follow a successful mutation. Keep the name durable
      // so `remove` can reconcile it instead of creating another display.
      console.error(`Creation didn't complete. Keep ${journal} and run remove to check for a partial allocation.`);
      throw error;
    }
  } else {
    if (statSync(journal).size > 4096) throw new Error("The probe journal is too large.");
    const record: unknown = JSON.parse(readFileSync(journal, "utf8"));
    if (typeof record !== "object" || record === null || !("name" in record) || typeof record.name !== "string") {
      throw new Error("The probe journal doesn't contain a display name.");
    }
    validateName(record.name);
    const current = await inspectDisplay(run, record.name);
    if (operation === "inspect") {
      console.log(JSON.stringify(current, null, 2));
    } else {
      if (!("phase" in record) || !["creating", "created", "removed"].includes(String(record.phase))) {
        throw new Error("The probe journal has an unknown state.");
      }
      if (record.phase === "removed" && current)
        throw new Error("A display reappeared after removal. Refusing to delete it.");
      if (record.phase === "creating" && !current) {
        throw new Error(
          "Creation is still unconfirmed. Keep the journal and check again after BetterDisplay has finished processing.",
        );
      }
      if (current) await removeDisplay(run, record.phase === "creating" ? current : ownedDisplay(record, record.name));
      save({ ...record, phase: "removed" });
      console.log("The probe display is gone.");
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
