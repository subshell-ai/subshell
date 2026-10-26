import {
  CROSS_AGENT_NOTES_MAX,
  joinPresetPrompt,
  parseSshForwardRows,
  SSH_FINGERPRINT_PATTERN,
  SSH_MAX_SELECTED_FINGERPRINTS,
} from "@internal/subshell-protocol";
import { z } from "zod";
import type { PresetRow, SshPreset } from "@/types/preset";

export const PRESET_FILE_MAX_BYTES = 1024 * 1024;
const name = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !/\p{Cc}/u.test(value), "Remove control characters from the name.");
const node = z.string().min(1).max(200).nullable();
const prompt = z
  .object({
    kind: z.enum(["saved", "custom", "stack"]),
    promptId: z.string().optional(),
    stackId: z.string().optional(),
    stackCount: z.number().optional(),
    description: z.string().max(200),
    body: z.string().max(20_000),
  })
  .strict();
const agent = z
  .object({
    kind: z.literal("agent"),
    name,
    description: z.string().max(500).nullable(),
    harnessId: z.string().min(1).max(200),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
    flags: z.array(z.string()),
    settings: z.record(z.string(), z.unknown()),
    configIsolation: z.boolean(),
    restartOnExit: z.boolean(),
    crossCommEnabled: z.boolean(),
    crossCommNotes: z.string().max(CROSS_AGENT_NOTES_MAX).nullable().optional(),
    nodeId: node,
    workingDir: z.string().max(4096).startsWith("/").nullable(),
    promptBlocks: z.array(prompt).max(50).nullable(),
    screen: z
      .object({
        width: z.number().int().min(320).max(4096),
        height: z.number().int().min(320).max(4096),
        provider: z
          .string()
          .regex(/^[a-z][a-z0-9-]{0,63}$/)
          .optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
const forward = z
  .object({
    kind: z.enum(["local", "remote", "dynamic"]),
    listenPort: z.number().int().min(1).max(65535),
    bindHost: z.string().nullable(),
    targetHost: z.string().nullable(),
    targetPort: z.number().int().min(1).max(65535).nullable(),
  })
  .strict();
const ssh = z
  .object({
    kind: z.literal("ssh"),
    name,
    description: z.string().max(500).nullable(),
    nodeId: node,
    destination: z.string().min(1).max(253),
    alias: z.string().min(1).max(253).nullable(),
    resolutionAlias: z.string().min(1).max(253).nullable(),
    authentication: z.enum(["connecting", "remote", "local-key", "password"]),
    keyHome: node,
    fingerprints: z.array(z.string().regex(new RegExp(SSH_FINGERPRINT_PATTERN))).max(SSH_MAX_SELECTED_FINGERPRINTS),
    forwards: z
      .array(forward)
      .refine((value) => parseSshForwardRows(value) !== null, "Invalid port forwarding settings."),
  })
  .strict();

/** Portable values only: identity, sharing grants, timestamps, and credentials are excluded. */
export const PresetFileSchema = z
  .object({
    format: z.literal("subshell-preset"),
    version: z.literal(1),
    preset: z.discriminatedUnion("kind", [agent, ssh]),
  })
  .strict()
  .superRefine(({ preset }, ctx) => {
    if (preset.kind === "agent") {
      if (preset.crossCommEnabled && !preset.workingDir) {
        ctx.addIssue({
          code: "custom",
          path: ["preset", "crossCommEnabled"],
          message: "Cross-subshell communication needs a working directory.",
        });
      }
      if (joinPresetPrompt(preset.promptBlocks ?? []).length > 20_000) {
        ctx.addIssue({
          code: "custom",
          path: ["preset", "promptBlocks"],
          message: "Combined prompt text exceeds 20,000 characters.",
        });
      }
    } else {
      if (
        preset.authentication === "remote" &&
        (!preset.fingerprints.length || (preset.keyHome !== null && preset.keyHome === preset.nodeId))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["preset", "keyHome"],
          message: "Remote authentication needs a different key node and at least one key fingerprint.",
        });
      }
      if (preset.authentication !== "remote" && (preset.keyHome !== null || preset.fingerprints.length)) {
        ctx.addIssue({
          code: "custom",
          path: ["preset", "authentication"],
          message: "Only remote authentication can include a key node or fingerprints.",
        });
      }
    }
  });
export type PresetFile = z.infer<typeof PresetFileSchema>;
export type ImportedPreset = PresetFile["preset"];

export function parsePresetFile(text: string): PresetFile {
  if (new TextEncoder().encode(text).byteLength > PRESET_FILE_MAX_BYTES)
    throw new Error("Choose a preset file smaller than 1 MiB.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("This file isn't valid JSON. Choose an exported .preset file.");
  }
  if (value && typeof value === "object" && "version" in value && value.version !== 1) {
    throw new Error("This preset file uses an unsupported version. This app supports version 1.");
  }
  const result = PresetFileSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `This preset file is invalid: ${issue?.path.join(".") || "file"}: ${issue?.message ?? "Check its fields."}`,
    );
  }
  return result.data;
}

export function presetFileFromRow(row: PresetRow | SshPreset): PresetFile {
  const preset =
    row.kind === "ssh"
      ? {
          kind: "ssh",
          name: row.name,
          description: row.description,
          nodeId: row.nodeId,
          destination: row.destination,
          alias: row.alias,
          resolutionAlias: row.resolutionAlias ?? null,
          authentication: row.authentication,
          keyHome: row.keyHome,
          fingerprints: row.fingerprints,
          forwards: row.forwards,
        }
      : {
          kind: "agent",
          name: row.name,
          description: row.description,
          harnessId: row.harnessId,
          env: row.envJson ? JSON.parse(row.envJson) : {},
          flags: row.flagsJson ? JSON.parse(row.flagsJson) : [],
          settings: row.settingsJson ? JSON.parse(row.settingsJson) : {},
          configIsolation: row.configIsolation === 1,
          restartOnExit: row.restartOnExit === 1,
          crossCommEnabled: row.crossCommEnabled === 1,
          crossCommNotes: row.crossCommNotes ?? null,
          nodeId: row.nodeId,
          workingDir: row.workingDir,
          promptBlocks: row.promptBlocks ? JSON.parse(row.promptBlocks) : null,
          ...(row.screenConfig ? { screen: JSON.parse(row.screenConfig) } : {}),
        };
  return parsePresetFile(JSON.stringify({ format: "subshell-preset", version: 1, preset }));
}

/** Preserve the name except characters the browser/filesystem cannot use in a filename. */
export function presetFileName(name: string) {
  return `${name.replace(/[<>:"/\\|?*\p{Cc}]/gu, "_").replace(/[. ]+$/g, "") || "preset"}.preset`;
}
export function downloadPreset(row: PresetRow | SshPreset): void {
  const file = presetFileFromRow(row);
  const text = `${JSON.stringify(file, null, 2)}\n`;
  parsePresetFile(text);
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = presetFileName(row.name);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The regular create endpoint remains the authority for permissions and availability. */
export function presetImportPayload(draft: ImportedPreset) {
  const { preset } = PresetFileSchema.parse({ format: "subshell-preset", version: 1, preset: draft });
  if (preset.kind === "ssh") {
    if (!preset.nodeId) throw new Error("Choose a connecting node before importing.");
    if (preset.authentication === "remote" && !preset.keyHome)
      throw new Error("Choose a node to supply the SSH keys before importing.");
    return { ...preset, nodeId: preset.nodeId, expectedDestination: preset.destination };
  }
  if (preset.crossCommEnabled && !preset.nodeId)
    throw new Error("Choose a launch node for cross-subshell communication before importing.");
  const { kind: _kind, ...body } = preset;
  return { ...body, description: body.description ?? undefined };
}
