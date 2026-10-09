export enum BackendErrorCodes {
  ACCESS_DENIED = "ACCESS_DENIED",
  /**
   * `PATCH /api/users/:id/approval`: the target's account is already
   * `approved`, so the write is not a queue decision. Approval only ever
   * moves a row OUT of `pending`/`rejected` (spec 2026-09-24 §8) — refusing
   * an approved target is what keeps this endpoint from being a state hammer
   * against active members (barring one is what disable is for).
   */
  APPROVAL_NOOP = "APPROVAL_NOOP",
  /** `POST /api/admin/server/autostart`: nothing is installed to start at login, or this server is not run by a service manager at all. */
  AUTOSTART_UNAVAILABLE = "AUTOSTART_UNAVAILABLE",
  BAD_REQUEST = "BAD_REQUEST",
  /** `PATCH /api/admin/server/config`: a value failed the CLI's `validateValue`; the message names the key and its reason. */
  CONFIG_INVALID = "CONFIG_INVALID",
  /** `PATCH /api/admin/server/config`: the key is set in the server's environment, so a config.env write would be masked at the next boot. */
  CONFIG_KEY_FROM_ENV = "CONFIG_KEY_FROM_ENV",
  /**
   * A `/api/auth-providers` SAVE whose issuer advertises the
   * client_credentials grant got a real token-endpoint refusal for the
   * offered pair. Nothing was written (operator ruling 2026-09-25: the save
   * IS the verification; the standalone probe route is gone).
   */
  CREDENTIALS_REJECTED = "CREDENTIALS_REJECTED",
  /** `/api/auth-providers`: OIDC discovery could not resolve the issuer's endpoints; the message names why. Raised on save, which IS the verification (spec 2026-09-24 §8, amended 2026-09-25). */
  DISCOVERY_FAILED = "DISCOVERY_FAILED",
  /** `PATCH /api/auth-providers/:id`: the reserved `email` row's kind is the credential provider's identity — it cannot be changed into an OIDC kind (or back). */
  EMAIL_ROW_IMMUTABLE_KIND = "EMAIL_ROW_IMMUTABLE_KIND",
  /** `DELETE /api/auth-providers/:id`: the reserved `email` row can be closed but never deleted (spec §2). */
  EMAIL_ROW_UNDELETABLE = "EMAIL_ROW_UNDELETABLE",
  EXISTS_ERROR = "EXISTS_ERROR",
  INPUT_VALIDATION_ERROR = "INPUT_VALIDATION_ERROR",
  INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR",
  INVALID_CREDENTIALS = "INVALID_CREDENTIALS",
  /** `POST /api/subshells/:id/restart` with a `presetId`: the preset is unknown, not the caller's, or belongs to a different harness. Nothing was written and no restart was attempted. */
  INVALID_PRESET = "INVALID_PRESET",
  /**
   * A write to `/api/auth-providers` would leave the instance with ZERO open
   * sign-in providers (spec 2026-09-24 §8's last-provider guard). Nothing was written;
   * the remedy is in the message — open another provider first, or break-glass
   * from the CLI.
   */
  LAST_SIGN_IN_PROVIDER = "LAST_SIGN_IN_PROVIDER",
  /** `PUT /api/admin/server/logging`: `SUBSHELL_DEBUG_LOGGING` is set in the environment, so the setting is read-only. */
  LOGGING_FROM_ENV = "LOGGING_FROM_ENV",
  NOT_FOUND_ERROR = "NOT_FOUND_ERROR",
  /** `/api/auth-providers/:id`: no provider row with that id. */
  PROVIDER_NOT_FOUND = "PROVIDER_NOT_FOUND",
  /**
   * The phase-1 placeholder refusing any non-local `POST /api/subshells` body.
   * Phase 2 removed the gate it served (§6.6 resolution is live); kept for
   * enum stability — the published value set never churns. Nothing throws it
   * anymore and no client references it (the old frontend belt comment is
   * gone); removing the member is possible but needs every client bundle
   * refreshed off the stale type first.
   * @deprecated Superseded by the §6.6 launch-node resolution (NODE_REQUIRED,
   * NODE_OFFLINE, and the plain 403/404s it produces).
   */
  NODE_LAUNCH_NOT_READY = "NODE_LAUNCH_NOT_READY",
  /**
   * `POST /api/nodes/:id/restart`: the node's binary predates the `restart` command.
   *
   * **`AGENT` here is the node daemon, and it stays.** The member name and its
   * VALUE are the same token, and that value ships as `code` in 409 bodies from
   * four routes, so it is a published API contract rather than an internal
   * name — unlike every other node-daemon identifier renamed on 2026-09-18.
   * Moving it belongs with the `nodes.kind = "agent"` column value, in a change
   * shaped like a migration. Do not "finish the job" here; the SENTENCES beside
   * this code are free to say "node", and do.
   */
  NODE_AGENT_TOO_OLD = "NODE_AGENT_TOO_OLD",
  NODE_NAME_TAKEN = "NODE_NAME_TAKEN",
  /** `POST /api/nodes/:id/restart`: the node is not the process its service manager started, so exiting would not be a restart. */
  NODE_NO_SERVICE = "NODE_NO_SERVICE",
  NODE_NOT_SUPERVISED = "NODE_NOT_SUPERVISED",
  /**
   * The node is in maintenance, so it takes no new subshells (spec
   * 2026-09-14). Raised by the launch gate from the plane's own record, and
   * also by mapping the agent's `in maintenance` refusal — the machine can
   * know before the plane does, since either end may set the flag.
   */
  NODE_IN_MAINTENANCE = "NODE_IN_MAINTENANCE",
  NODE_OFFLINE = "NODE_OFFLINE",
  NODE_ONLINE = "NODE_ONLINE",
  /**
   * The node's own agent answered `unsupported` to a command it does not
   * implement (today: `fs_ls`, the remote folder picker). The exact-match
   * gate means a connected agent normally speaks this protocol; the relay
   * stays for the honest case — the agent's answer beats our inference —
   * and the message names the remedy: update the subshell app on that node.
   */
  NODE_OUTDATED = "NODE_OUTDATED",
  NODE_REQUIRED = "NODE_REQUIRED",
  /** `POST /api/nodes/:id/restart`: the node's service definition would close its live panes; pass `force`. */
  NODE_RESTART_KILLS_PANES = "NODE_RESTART_KILLS_PANES",
  NODE_RUNNING_SUBSHELLS = "NODE_RUNNING_SUBSHELLS",
  NODE_UNREACHABLE = "NODE_UNREACHABLE",
  /** `POST /api/subshells/:id/restart` with a `presetId`: another restart for this subshell already holds the in-flight lease. A plain restart would join it; a swap cannot ride another caller's revival, so nothing was written and the caller may retry once the running restart finishes. */
  RESTART_IN_FLIGHT = "RESTART_IN_FLIGHT",
  /** `POST /api/admin/server/restart`: the installed service definition would close live panes; pass `force`. */
  RESTART_KILLS_PANES = "RESTART_KILLS_PANES",
  /** `POST /api/admin/server/restart`: this server is not running under a service manager, so exiting would stop it. */
  RESTART_UNAVAILABLE = "RESTART_UNAVAILABLE",
  /**
   * `POST /api/subshells/:id/input`: the row is not RUNNING, so there is no
   * pane to type into. Nothing was written and no input was sent; the caller's
   * remedy is a restart, not a retry of the same POST.
   */
  SUBSHELL_NOT_RUNNING = "SUBSHELL_NOT_RUNNING",
  /** exec (spec 2026-10-02): the harness in this pane is not a terminal; nothing was typed. */
  EXEC_TERMINAL_ONLY = "EXEC_TERMINAL_ONLY",
  /** exec: the pane's log grew inside the quiet window; nothing was typed. */
  EXEC_PANE_BUSY = "EXEC_PANE_BUSY",
  /** exec: another exec already holds this pane's lease. */
  EXEC_IN_FLIGHT = "EXEC_IN_FLIGHT",
  /**
   * `POST /api/subshells`: the row was retired between its INSERT and its
   * spawn — a maintenance window opening on that node, or a plain terminate.
   * A lost race with a legitimate concurrent act, not a fault: the pane is
   * killed and the row stays retired, and the caller may simply try again.
   */
  SUBSHELL_STOPPED_WHILE_STARTING = "SUBSHELL_STOPPED_WHILE_STARTING",
  SETUP_KEY_CONSUMED = "SETUP_KEY_CONSUMED",
  SETUP_KEY_EXPIRED = "SETUP_KEY_EXPIRED",
  SETUP_KEY_INVALID = "SETUP_KEY_INVALID",
  /** `POST /api/auth-providers`: the chosen id slug already names a row. Ids are the callback path's identity and never get renumbered (spec §2). */
  SLUG_TAKEN = "SLUG_TAKEN",
  /** `POST /api/admin/server/update`: `SUBSHELL_RELEASE_URL` is empty — this instance fetches no releases (the air-gapped configuration). */
  UPDATE_SOURCE_DISABLED = "UPDATE_SOURCE_DISABLED",
  /**
   * `POST /api/admin/server/update`: nothing on this host names a binary an
   * update could replace — a checkout (update it with git), a directory this
   * user cannot write, or no service definition and a process that is not an
   * installed one. The message carries the reason.
   */
  UPDATE_BINARY_UNKNOWN = "UPDATE_BINARY_UNKNOWN",
  /** `POST /api/admin/server/update`: the image marker says this install updates by pulling a new image, not by swapping a binary; the message names the image as the unit of update (spec 2026-09-28 § 6). */
  UPDATE_CONTAINERIZED = "UPDATE_CONTAINERIZED",
  /** `POST /api/admin/server/update`: a marker is already on disk, or a job is running. */
  UPDATE_IN_PROGRESS = "UPDATE_IN_PROGRESS",
  /** `POST /api/admin/server/update`: no newer release, and the body named no version. */
  UPDATE_NOT_AVAILABLE = "UPDATE_NOT_AVAILABLE",
  /**
   * `POST /api/admin/server/update`: the named version is older than the
   * running one. The API has no override for this and the CLI does (`--force`),
   * deliberately: a downgrade may leave a database the older binary cannot
   * open (kysely refuses unknown migrations), so it is a terminal act rather
   * than a button.
   */
  UPDATE_DOWNGRADE = "UPDATE_DOWNGRADE",
  /**
   * `POST /api/nodes/:id/update`: the node already runs the newest release
   * this server can offer, so the command would only re-download and reinstall
   * the same binary. Refused before anything is sent.
   */
  NODE_UP_TO_DATE = "NODE_UP_TO_DATE",
  /**
   * `POST /api/nodes/:id/update`: this plane has no node release it can offer
   * — none published, none carrying a release manifest, or the newest one
   * speaks a different protocol. The message names which.
   */
  NODE_UPDATE_UNAVAILABLE = "NODE_UPDATE_UNAVAILABLE",
  /** `POST /api/nodes/:id/update`: the agent refused or could not apply it; the message is the agent's own. */
  NODE_UPDATE_FAILED = "NODE_UPDATE_FAILED",
  /**
   * `/api/network/:id/*`: this host's OS is not in the plugin's
   * `subshell.network.platforms`. Manifest DATA, so it is known without
   * loading plugin code and a surface renders the row unavailable rather than
   * offering a button that would 409.
   */
  PLATFORM_UNSUPPORTED = "PLATFORM_UNSUPPORTED",
  /**
   * `POST /api/network/:id/join|publish`: the plugin's live `status()` is
   * below `needs-login` — the vendor CLI is missing, its daemon is down, or
   * this OS user may not drive it. The message is the first hint the plugin
   * gave, so the refusal names the remedy rather than the state.
   */
  NETWORK_NOT_READY = "NETWORK_NOT_READY",
  /**
   * `POST /api/network/:id/join|publish`: a `required` settings field has no
   * value (or a `required` secret field has nothing stored). Configuration
   * this act cannot invent, so it is refused before anything runs.
   */
  NETWORK_UNCONFIGURED = "NETWORK_UNCONFIGURED",
  /**
   * A `/api/ssh` act on a machine SSH is not open for, or not open for THIS
   * caller: SSH is off, launch access is missing, or instance policy
   * disables launches. One code for these
   * causes; the message names the true one, because naming WHY is the
   * surface's job (spec §12) and the code is the machine-readable half.
   */
  SSH_GATE_OFF = "SSH_GATE_OFF",
  /**
   * A `/api/ssh` act against a HELD agent: the plane refuses to speak that
   * machine's protocol, so no ssh command can be sent and none is. The
   * message names the remedy — update the node (spec 2026-10-07 decision 6).
   */
  NODE_PROTOCOL_HELD = "NODE_PROTOCOL_HELD",
  /**
   * A `/api/ssh` destination (or alias) that the wire grammar cannot carry:
   * blank, over the 253-char cap, leading `-` (option-like), or carrying
   * whitespace/control characters. Refused before the machine is asked, so
   * the token never reaches `ssh -G` or a config parse.
   */
  ALIAS_UNSAFE = "ALIAS_UNSAFE",
  /**
   * The connecting machine answered an ssh command with its own `ok:false`
   * (its ssh-enabled mirror says no, no ssh binary, a malformed answer): the
   * plane's row cannot overrule the machine. The agent's own text is never
   * echoed; the message names the human's remedy.
   */
  SSH_NODE_REFUSED = "SSH_NODE_REFUSED",
  /**
   * `POST /api/subshells/:id/restart` on an ssh pane (spec 2026-10-07
   * decision 7): the pane's session lives on the far end of a socket, so a
   * restart would spawn a new ssh process nobody asked to reconnect. Launch
   * again from the launcher instead. Keyed to the `subshells.ssh` column.
   */
  SSH_NO_RESTART = "SSH_NO_RESTART",
  /**
   * A pane-input act (REST input, exec, MCP-via-REST, WS keystroke) on an
   * ssh pane by a caller who is not the row's OWNER account, or by ANY
   * machine credential (spec 2026-10-07 §5.4, decision 5: the far side of an
   * ssh pane runs under the owner's own trust; the pane's key must not type
   * into itself either). Keyed to the `subshells.ssh` column like the
   * restart refusal; the WS door drops the frame rather than answering this
   * code, exactly as it drops a `view` grantee's keystrokes.
   */
  SSH_OWNER_INPUT_ONLY = "SSH_OWNER_INPUT_ONLY",
  /**
   * A connection selecting MORE than `SSH_MAX_SELECTED_FINGERPRINTS` keys
   * (spec 2026-10-08 §5.4): a named refusal before opening the relay,
   * never a silent truncation of the operator's selection.
   */
  SSH_KEYS_OVER_LIMIT = "SSH_KEYS_OVER_LIMIT",
  /**
   * A selected fingerprint outside the `SHA256:` display grammar (agent-wire
   * base64; `isSshFingerprints`). Refused before any write; the value
   * itself is never echoed into the message.
   */
  SSH_KEYS_INVALID = "SSH_KEYS_INVALID",
  /**
   * The relay broker refused to open (spec 2026-10-08 §5.3): quota, gate,
   * handshake, or a refused side. The pane was not launched; the message
   * names which door. No session exists.
   */
  SSH_RELAY_OPEN_FAILED = "SSH_RELAY_OPEN_FAILED",
  /**
   * A relay launch aimed at a machine that has no registered relay identity
   * (spec 2026-10-08 §4.2/§4.3: no `node:` record, or its signing slot is
   * still empty). The remedy is on the machine: re-enroll, or let its next
   * `ready` fill the slot.
   */
  SSH_RELAY_IDENTITY_MISSING = "SSH_RELAY_IDENTITY_MISSING",
  /**
   * A relay connection refused because the key home has no recorded host
   * key for the destination. The connecting machine requires a pin from
   * the key home and cannot fall back to its own ambient TOFU. The remedy the message names: connect to
   * the destination once from the key home, or supply the key on the trust
   * screen.
   */
  SSH_HOST_PIN_MISSING = "SSH_HOST_PIN_MISSING",
  /**
   * The host-key capture found the destination pinned to a DIFFERENT key
   * (spec 2026-10-08 §9): the TOFU hard block at the plane's edge, the mirror
   * of the block OpenSSH itself raises on B. Nothing is overwritten; recovery
   * is verify the new key, delete the old pin on the trust screen and retry.
   */
  SSH_HOST_PIN_CHANGED = "SSH_HOST_PIN_CHANGED",
  /**
   * A host-key line (an explicit pin, or a canonical destination) the wire
   * grammar refuses: not one bounded printable line, a comment or blank, a
   * smuggled newline. Refused before any write (spec 2026-10-08 §9).
   */
  SSH_HOST_PIN_INVALID = "SSH_HOST_PIN_INVALID",
  /**
   * The "Set up Subshell here" act's named EGRESS refusal (spec 2026-10-08
   * §7): the destination cannot reach the plane URL, so the install cannot
   * run and no key was ever spent on an enrollment. Deliberately a code of
   * its own: the spec requires this cause to read differently from any key
   * error, and the working pane is untouched either way.
   */
  SSH_UPGRADE_EGRESS = "SSH_UPGRADE_EGRESS",
  /**
   * The "Set up Subshell here" act stopped at a NAMED stage short of an
   * enrolled, connected node (spec 2026-10-08 §7): the install failed, the
   * enrollment was refused, or the new node never reported `ready` within
   * the bounded wait. The message names which stage; the setup key is
   * nowhere in it, and the interactive pane is untouched.
   */
  SSH_UPGRADE_FAILED = "SSH_UPGRADE_FAILED",
}

export const BackendErrorCodeDefs = {
  [BackendErrorCodes.ACCESS_DENIED]: {
    message: "Access denied",
    statusCode: 403,
  },
  [BackendErrorCodes.APPROVAL_NOOP]: {
    message: "That account is already approved",
    statusCode: 409,
  },
  [BackendErrorCodes.BAD_REQUEST]: {
    message: "Bad request",
    statusCode: 400,
  },
  [BackendErrorCodes.CONFIG_INVALID]: {
    message: "Invalid configuration value",
    statusCode: 400,
  },
  [BackendErrorCodes.CONFIG_KEY_FROM_ENV]: {
    message: "That setting is fixed by the server's environment",
    statusCode: 409,
  },
  [BackendErrorCodes.CREDENTIALS_REJECTED]: {
    message: "The OIDC token endpoint rejected the supplied client credentials",
    statusCode: 400,
  },
  [BackendErrorCodes.DISCOVERY_FAILED]: {
    message: "OIDC discovery could not resolve this issuer",
    statusCode: 400,
  },
  [BackendErrorCodes.EMAIL_ROW_IMMUTABLE_KIND]: {
    message: "The E-mail provider's kind cannot be changed",
    statusCode: 400,
  },
  [BackendErrorCodes.EMAIL_ROW_UNDELETABLE]: {
    message: "The E-mail provider can be closed but never deleted",
    statusCode: 400,
  },
  [BackendErrorCodes.EXISTS_ERROR]: {
    message: "Resource already exists",
    statusCode: 409,
  },
  [BackendErrorCodes.INPUT_VALIDATION_ERROR]: {
    message: "Invalid input",
    statusCode: 400,
  },
  [BackendErrorCodes.INTERNAL_SERVER_ERROR]: {
    message: "Internal server error",
    statusCode: 500,
  },
  [BackendErrorCodes.INVALID_CREDENTIALS]: {
    message: "Invalid credentials",
    statusCode: 401,
  },
  [BackendErrorCodes.INVALID_PRESET]: {
    message: "Invalid preset",
    statusCode: 400,
  },
  [BackendErrorCodes.LAST_SIGN_IN_PROVIDER]: {
    message: "This would leave no way to sign in",
    statusCode: 409,
  },
  [BackendErrorCodes.NOT_FOUND_ERROR]: {
    message: "Resource not found",
    statusCode: 404,
  },
  [BackendErrorCodes.PROVIDER_NOT_FOUND]: {
    message: "Auth provider not found",
    statusCode: 404,
  },
  [BackendErrorCodes.NODE_LAUNCH_NOT_READY]: {
    message: "Remote node launch is not available yet",
    statusCode: 409,
  },
  [BackendErrorCodes.LOGGING_FROM_ENV]: {
    message: "Debug logging is fixed by the server's environment",
    statusCode: 409,
  },
  [BackendErrorCodes.NODE_AGENT_TOO_OLD]: {
    message: "This node's binary is too old for this command",
    statusCode: 409,
  },
  [BackendErrorCodes.NODE_NAME_TAKEN]: {
    message: "You already have a node with this name",
    statusCode: 409,
  },
  [BackendErrorCodes.NODE_OFFLINE]: {
    message: "Node is offline",
    statusCode: 409,
  },
  [BackendErrorCodes.NODE_IN_MAINTENANCE]: {
    message: "Node is in maintenance",
    statusCode: 409,
  },
  [BackendErrorCodes.SUBSHELL_NOT_RUNNING]: {
    message: "The subshell is not running",
    statusCode: 409,
  },
  [BackendErrorCodes.EXEC_TERMINAL_ONLY]: {
    message: "exec types into terminal panes only",
    statusCode: 400,
  },
  [BackendErrorCodes.EXEC_PANE_BUSY]: {
    message: "The pane is producing output; exec typed nothing",
    statusCode: 409,
  },
  [BackendErrorCodes.EXEC_IN_FLIGHT]: {
    message: "Another exec is already waiting on this pane",
    statusCode: 409,
  },
  [BackendErrorCodes.SUBSHELL_STOPPED_WHILE_STARTING]: {
    message: "The subshell was stopped while it was starting",
    statusCode: 409,
  },
  [BackendErrorCodes.NODE_NO_SERVICE]: {
    message: "Node has no service definition installed",
    statusCode: 409,
  },
  [BackendErrorCodes.NODE_NOT_SUPERVISED]: {
    message: "This node is not running under a service manager",
    statusCode: 409,
  },
  [BackendErrorCodes.NODE_ONLINE]: {
    message: "Node is online",
    statusCode: 409,
  },
  [BackendErrorCodes.NODE_OUTDATED]: {
    message: "The subshell app on this node is too old for this feature",
    statusCode: 409,
  },
  [BackendErrorCodes.NODE_REQUIRED]: {
    message: "No launch-eligible node; pick one",
    statusCode: 400,
  },
  [BackendErrorCodes.NODE_RUNNING_SUBSHELLS]: {
    message: "Node has running subshells",
    statusCode: 409,
  },
  [BackendErrorCodes.NODE_RESTART_KILLS_PANES]: {
    message: "Restarting this node would close its running subshells",
    statusCode: 409,
  },
  [BackendErrorCodes.NODE_UNREACHABLE]: {
    message: "Node did not respond",
    statusCode: 409,
  },
  [BackendErrorCodes.AUTOSTART_UNAVAILABLE]: {
    message: "This server has no installed service to start at login",
    statusCode: 409,
  },
  [BackendErrorCodes.RESTART_KILLS_PANES]: {
    message: "Restarting would close every running subshell",
    statusCode: 409,
  },
  [BackendErrorCodes.RESTART_UNAVAILABLE]: {
    message: "This server is not running under a service manager",
    statusCode: 409,
  },
  [BackendErrorCodes.RESTART_IN_FLIGHT]: {
    message: "Another restart for this subshell is already running",
    statusCode: 409,
  },
  [BackendErrorCodes.SETUP_KEY_CONSUMED]: {
    message: "Setup key has already been used",
    statusCode: 401,
  },
  [BackendErrorCodes.SETUP_KEY_EXPIRED]: {
    message: "Setup key has expired",
    statusCode: 401,
  },
  [BackendErrorCodes.SETUP_KEY_INVALID]: {
    message: "Invalid setup key",
    statusCode: 401,
  },
  [BackendErrorCodes.SLUG_TAKEN]: {
    message: "That provider id is already taken",
    statusCode: 409,
  },
  // Every update refusal is a 409: the request is well-formed and the caller
  // is allowed to make it — the host is simply not in a state where it can be
  // honoured. Same shape as RESTART_UNAVAILABLE, which they sit beside.
  [BackendErrorCodes.UPDATE_SOURCE_DISABLED]: {
    message: "This server does not fetch releases",
    statusCode: 409,
  },
  [BackendErrorCodes.UPDATE_CONTAINERIZED]: {
    message: "This server runs inside a container; the image is the unit of update",
    statusCode: 409,
  },
  [BackendErrorCodes.UPDATE_BINARY_UNKNOWN]: {
    message: "No installed binary this server could replace",
    statusCode: 409,
  },
  [BackendErrorCodes.UPDATE_IN_PROGRESS]: {
    message: "An update is already in progress",
    statusCode: 409,
  },
  [BackendErrorCodes.UPDATE_NOT_AVAILABLE]: {
    message: "There is no newer release to install",
    statusCode: 409,
  },
  [BackendErrorCodes.UPDATE_DOWNGRADE]: {
    message: "That version is older than the one running",
    statusCode: 409,
  },
  [BackendErrorCodes.NODE_UP_TO_DATE]: {
    message: "This node is already running the newest version this server can offer",
    statusCode: 409,
  },
  [BackendErrorCodes.NODE_UPDATE_UNAVAILABLE]: {
    message: "No node release can be offered",
    statusCode: 409,
  },
  [BackendErrorCodes.NODE_UPDATE_FAILED]: {
    message: "The node could not apply the update",
    statusCode: 409,
  },
  // Every network refusal is a 409 for the reason the update ones are: the
  // request is well formed and the caller is allowed to make it — this host
  // is simply not in a state where it can be honoured.
  [BackendErrorCodes.PLATFORM_UNSUPPORTED]: {
    message: "This plugin cannot run on this platform",
    statusCode: 409,
  },
  [BackendErrorCodes.NETWORK_NOT_READY]: {
    message: "This network is not ready on this host",
    statusCode: 409,
  },
  [BackendErrorCodes.NETWORK_UNCONFIGURED]: {
    message: "This network needs configuring first",
    statusCode: 409,
  },
  [BackendErrorCodes.SSH_GATE_OFF]: {
    message: "Subshell SSH is off on this machine",
    statusCode: 403,
  },
  [BackendErrorCodes.NODE_PROTOCOL_HELD]: {
    message: "This node is held for speaking a protocol this server does not",
    statusCode: 409,
  },
  [BackendErrorCodes.ALIAS_UNSAFE]: {
    message: "That SSH destination is not a safe token",
    statusCode: 400,
  },
  // The machine's own refusal is not a client error and not a server fault:
  // the request was valid, the connecting host answered no. 502 says the
  // upstream (the node) refused, which is exactly the shape.
  [BackendErrorCodes.SSH_NODE_REFUSED]: {
    message: "The connecting machine refused the SSH request",
    statusCode: 502,
  },
  [BackendErrorCodes.SSH_NO_RESTART]: {
    message: "SSH panes are not restarted; launch again to reconnect",
    statusCode: 409,
  },
  [BackendErrorCodes.SSH_OWNER_INPUT_ONLY]: {
    message: "SSH panes accept input from their owner only",
    statusCode: 403,
  },
  [BackendErrorCodes.SSH_KEYS_OVER_LIMIT]: {
    message: "Too many SSH keys selected",
    statusCode: 400,
  },
  [BackendErrorCodes.SSH_KEYS_INVALID]: {
    message: "That SSH key selection is invalid",
    statusCode: 400,
  },
  [BackendErrorCodes.SSH_RELAY_OPEN_FAILED]: {
    message: "The relay refused to open; the pane was not launched",
    statusCode: 409,
  },
  [BackendErrorCodes.SSH_RELAY_IDENTITY_MISSING]: {
    message: "That machine has no registered relay identity yet",
    statusCode: 409,
  },
  [BackendErrorCodes.SSH_HOST_PIN_MISSING]: {
    message: "The key home has no recorded host key for that destination",
    statusCode: 409,
  },
  [BackendErrorCodes.SSH_HOST_PIN_CHANGED]: {
    message: "The host key for that destination does not match the stored pin",
    statusCode: 409,
  },
  [BackendErrorCodes.SSH_HOST_PIN_INVALID]: {
    message: "That host-key entry is not a valid known_hosts line",
    statusCode: 400,
  },
  [BackendErrorCodes.SSH_UPGRADE_EGRESS]: {
    message: "The destination cannot reach this server, so it cannot install Subshell",
    statusCode: 409,
  },
  [BackendErrorCodes.SSH_UPGRADE_FAILED]: {
    message: "Setting up Subshell here did not finish",
    statusCode: 409,
  },
};
