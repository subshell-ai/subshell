import { isCancel, password } from "@clack/prompts";
import { type PasswordDeps, askPassword as requestPassword } from "@/modules/backups/password.js";

/** Native terminal password prompt; reusable workflows receive it through their dependencies. */
export async function promptBackupPassword(message: string): Promise<string | null> {
  const answer = await password({ message });
  return isCancel(answer) ? null : answer;
}

/** Prompt and validate a password for CLI backup operations. */
export function askPassword(question: string, repeat: boolean, deps: PasswordDeps): Promise<string> {
  return requestPassword(question, repeat, { ...deps, secretPrompt: deps.secretPrompt ?? promptBackupPassword });
}
