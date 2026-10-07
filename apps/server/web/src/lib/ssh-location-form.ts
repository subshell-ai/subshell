import type { FieldProblems } from "@/lib/form";

export function sshLocationProblems(value: { path: string }): FieldProblems {
  return value.path.startsWith("/") && !value.path.includes("\0") && value.path.length <= 4096
    ? {}
    : { path: "Choose an absolute folder path on the remote host before saving this location." };
}
