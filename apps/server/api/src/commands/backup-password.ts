import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isCancel, password } from "@clack/prompts";

export interface PasswordDeps {
  isTTY?: boolean;
  secretPrompt?: (question: string) => Promise<string | null>;
}

/** Passwords are one UTF-8 line, max 4096 characters, supplied outside argv. */
export function readPasswordFile(path: string): string {
  const fd = path === "-" ? 0 : openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (path !== "-") {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
        throw new Error(
          "Password file must be a regular file owned by this user with no group or other permissions (chmod 600).",
        );
      if (stat.size > 16_386) throw new Error("Password file exceeds the permitted length.");
    }
    const bytes: number[] = [];
    const one = Buffer.alloc(1);
    for (;;) {
      let n: number;
      try {
        n = readSync(fd, one, 0, 1, null);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN") {
          Bun.sleepSync(5);
          continue;
        }
        throw error;
      }
      if (!n) break;
      bytes.push(one[0] as number);
      if (bytes.length > 16_386) throw new Error("Password exceeds the permitted length.");
      if (path === "-" && one[0] === 10) break;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)).replace(/\r?\n$/, "");
    if (!text || text.length > 4096 || /[\r\n\0]/.test(text))
      throw new Error("Password must be one nonempty line of at most 4096 characters.");
    return text;
  } finally {
    if (path !== "-") closeSync(fd);
  }
}

export async function askPassword(question: string, repeat: boolean, deps: PasswordDeps): Promise<string> {
  if (!deps.isTTY)
    throw new Error("A password requires --password-file <path|-> when no interactive terminal is available.");
  const ask =
    deps.secretPrompt ??
    (async (message: string) => {
      const answer = await password({ message });
      return isCancel(answer) ? null : answer;
    });
  const first = await ask(question);
  if (first === null) throw new Error("Cancelled; nothing was changed.");
  if (!first || first.length > 4096 || /[\r\n\0]/.test(first))
    throw new Error("Password must be one nonempty line of at most 4096 characters.");
  if (repeat && (await ask("Repeat the password")) !== first)
    throw new Error("Passwords did not match; nothing was changed.");
  return first;
}
