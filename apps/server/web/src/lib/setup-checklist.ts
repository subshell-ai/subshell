import { isLoopbackUrl } from "@internal/server/config-values";
import { type PersistenceFix, type PersistenceInput, persistence } from "@/lib/supervision";
import { tmuxInstallHint } from "@/lib/tmux-install";

/**
 * Which item this is. Stable strings rather than an index: the card keys its
 * rows on them, and the tests name them.
 */
export type ChecklistItemId = "tmux" | "agent-cli" | "lan-origin" | "auth-secret" | "persistence";

/**
 * What a person can do about one item — deliberately DATA, not copy, for the
 * same reason `persistence()` returns a {@link PersistenceFix} rather than a
 * sentence: a remedy is rendered differently depending on what it is (a
 * command is copied, a route is a `Link`, a button POSTs), and a model that
 * shipped the markup would be answering a question it cannot see.
 */
export type ChecklistRemedy =
  /** A shell command to run ON the control-plane host, shown copyable */
  | {
      kind: "command";
      /** The command line, verbatim */
      command: string;
      /** What the copy button calls it */
      label: string;
      /** What to do with the command's output, when copying it is not the whole fix */
      note?: string;
    }
  /**
   * A page of this SPA that carries the actual control.
   *
   * The destination is a LITERAL union rather than a string, and the variant
   * carrying params is split out, because TanStack's `Link` is typed against
   * the route tree: a `to: string` would force a cast at the render site,
   * which is exactly where a route renamed later should fail to compile.
   */
  | { kind: "link"; to: "/settings/service"; label: string }
  | { kind: "link"; to: "/nodes/$id"; params: { id: string }; label: string }
  /**
   * The supervision remedy, passed through from `lib/supervision.ts` so this
   * list and the Service page's card cannot disagree about what is wrong or
   * what fixes it.
   */
  | { kind: "persistence"; fix: PersistenceFix };

/** One thing this instance still needs, as the card renders it. */
export interface ChecklistItem {
  /** Stable id — the row key, and what tests assert on */
  id: ChecklistItemId;
  /** The act, as an imperative: what the person is being asked to do */
  title: string;
  /** What is true until they do it. One sentence, naming the symptom they would otherwise meet cold */
  consequence: string;
  /** How to do it, or null when this build cannot name a way */
  remedy: ChecklistRemedy | null;
}

/**
 * The facts the list is composed from — every one of them already on screen
 * somewhere else, which is the whole point of the card (spec 2026-09-15
 * § 5.2): what was missing was never a fact, it was one place that says which
 * of them still need doing.
 *
 * Narrow fields rather than the three API shapes they come from, so this
 * function is testable without constructing an `AdminStatus`, a
 * `ServerDeployment` and a harness list to change one boolean.
 */
export interface ChecklistInputs {
  /** The tmux binary the server resolved, null when it found none */
  tmuxPath: string | null;
  /** Host OS as `GET /api/admin/server` reports it: `darwin`, `linux`, … */
  platform: string;
  /** The machine's supervision facts, exactly as `persistence()` reads them */
  persistence: PersistenceInput;
  /** The saved `HOST` — the bind address this server is configured with */
  host: string;
  /** The saved `APP_BASE_URL` */
  appBaseUrl: string;
  /** The saved `TRUSTED_ORIGINS`, comma-separated as the server reports it */
  trustedOrigins: string;
  /** True while `BETTER_AUTH_SECRET` is still the value that ships in the source */
  usingPlaceholderSecret: boolean;
  /** Where this server's config.env is, so the secret remedy can name it */
  configEnvPath: string;
  /** Whether ANY agent harness was detected on the control-plane host */
  anyAgentInstalled: boolean;
}

/**
 * Whether a browser on ANOTHER machine has any address this instance would
 * accept — the configuration `applyConfig`'s third warning is about
 * (`apps/server/api/src/commands/configure.ts`).
 *
 * **One deliberate divergence from that warning's predicate, and it is the
 * difference between an item that fires and one that never can.** The CLI
 * tests `normalizeTrustedOrigins(value) === ""`, because at the moment it
 * writes config.env an absent key really is the empty string. The deployment
 * view this card reads fills an absent key with `DEFAULT_TRUSTED_ORIGINS` —
 * the two `localhost` Vite origins — so the empty string never arrives here
 * and an exact transcription would be dead code on precisely the headless
 * installs the item exists for. So the test is the one the CLI's sentence
 * actually makes ("a browser on any other machine sends an origin this
 * instance does not trust"): every configured origin is loopback. On an
 * absent key that is the same answer the CLI gives; the two cannot disagree
 * about a configuration either of them can see.
 */
function lanSignInRefused(input: ChecklistInputs): boolean {
  // `constants.ts` derives the allowlist from the port, a CONCRETE host and
  // the base URL, so a wildcard bind contributes nothing and a loopback base
  // URL contributes two loopback spellings.
  if (input.host !== "0.0.0.0") return false;
  if (!isLoopbackUrl(input.appBaseUrl)) return false;
  return input.trustedOrigins
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .every((entry) => isLoopbackUrl(entry));
}

/**
 * What this instance still needs, as a list — empty when it needs nothing.
 *
 * Ordered by what it costs to leave undone rather than by where the fact
 * lives: tmux stops every launch, a host with no agent CLI can run only a
 * plain terminal, an untrusted LAN origin stops everyone else signing in, the
 * placeholder secret is a security fact nobody is currently blocked by, and
 * supervision bites only at the next reboot. A reader who fixes them top to
 * bottom is never blocked by something further down the list.
 *
 * @param input - facts from `GET /api/admin/status`, `GET /api/admin/server`
 *   and the host's harness detection
 */
export function checklistItems(input: ChecklistInputs): ChecklistItem[] {
  const items: ChecklistItem[] = [];

  if (input.tmuxPath === null) {
    const command = tmuxInstallHint(input.platform)?.command ?? null;
    items.push({
      id: "tmux",
      title: "Install tmux",
      consequence:
        "Nothing can launch on this machine: every subshell runs inside a tmux pane, and the server found no tmux.",
      remedy: command === null ? null : { kind: "command", command, label: "Install command" },
    });
  }

  if (!input.anyAgentInstalled) {
    items.push({
      id: "agent-cli",
      title: "Install an agent CLI",
      consequence:
        "No agent was detected here, so a subshell on this machine can only be a plain terminal. Nodes you add have their own answer.",
      remedy: { kind: "link", to: "/nodes/$id", params: { id: "local" }, label: "This machine" },
    });
  }

  if (lanSignInRefused(input)) {
    items.push({
      id: "lan-origin",
      title: "Name the address other machines will use",
      consequence:
        'This server accepts connections from the network, but trusts only its own loopback addresses: a browser on another machine is refused at sign-in with 403 "Invalid origin", which names nothing you could change.',
      remedy: { kind: "link", to: "/settings/service", label: "Addresses" },
    });
  }

  if (input.usingPlaceholderSecret) {
    items.push({
      id: "auth-secret",
      title: "Set a real signing secret",
      consequence:
        "Sessions are signed with the placeholder value that ships in the source, so anyone who has it can mint one for this instance.",
      remedy: {
        kind: "command",
        command: "openssl rand -base64 32",
        label: "Secret generator",
        // Named as a config.env key rather than as a command that writes it.
        // `subshell-server init` GENERATES a secret only when none is set, and
        // the placeholder is what "none is set" already resolves to — so
        // re-running it is the one fix that looks obvious and does nothing.
        note: `Add the output as BETTER_AUTH_SECRET in ${input.configEnvPath}, then restart the server. Everyone signed in now is signed out.`,
      },
    });
  }

  // The sentence AND the remedy come from `persistence()` — the model the
  // Service page's card and a node's Runtime card already answer this with.
  // A `null` fix is a machine that needs nothing (or one nobody here can do
  // anything about), and a checklist entry with no act is not an item.
  const { sentence, fix } = persistence(input.persistence, "this machine");
  if (fix !== null) {
    items.push({
      id: "persistence",
      title: persistenceTitle(fix),
      consequence: sentence,
      remedy: { kind: "persistence", fix },
    });
  }

  return items;
}

/**
 * The act each supervision fix asks for. This is the one piece of copy the
 * checklist adds to `persistence()`, and it has to be an imperative where
 * that model's output is a statement — every other row of this card names a
 * thing to do, and a row that only described a state would read as noise.
 */
function persistenceTitle(fix: PersistenceFix): string {
  switch (fix.kind) {
    case "install":
      return "Have this machine run the server";
    case "enable":
      return "Start the server at login";
    case "linger":
      return "Keep the server up with nobody logged in";
  }
}
