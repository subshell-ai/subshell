import { stopStack } from "./stack";

export default async function globalTeardown(): Promise<void> {
  await stopStack();
}
