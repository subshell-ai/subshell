# Form section hierarchy

The approved layout is A3: a compact section title with a fine rule continuing
beside it. A section must remain recognizable when it has no description.

Use `FormSectionTitle` from `@internal/assistant`, also re-exported by
`@internal/node-admin`. Its default is an h3; use `as="legend"` for a fieldset
and `as="h2"` for page-level groups. Preserve ids used by `aria-labelledby`.
The decorative line is hidden from assistive technology. Do not stack another
horizontal divider above the title.

Section titles are 16px semibold. Field labels retain their label role, helpers
use `HelperCaption` where appropriate, and warnings and errors retain detail
size. Card and dialog titles remain their own hierarchy: a simple form inside a
card does not need another heading repeating the card title.

## Source audit, 2026-10-21

The audit covered form, fieldset, label, and heading renderers in the server SPA,
node dashboard, shared node-admin components, both desktop interfaces, and the
native mobile forms. Marketing and documentation pages are outside the product
form system.

| Surface | Result |
| --- | --- |
| Preset create/edit and launch forms | Shared section titles for launch defaults, prompts, cross-agent communication, and expanded agent settings. Static agent value uses label size. |
| Prompt library and stacks | Shared title for inline picker sections; prompt description, body, and sharing remain field labels. Dialog titles stay dialog titles. |
| SSH connect and SSH presets | Shared legends for authentication, agent keys, and port forwards; destination and machine inputs remain labelled fields. |
| Sign-in, account, passwords, passkeys, users and API keys | Single-group forms keep their card/dialog titles and field labels. |
| Authentication providers | Provider registration instructions use the shared legend. Provider fields and permission switches remain labels. |
| Node settings, setup keys, enrollment and directory editors | Card headings already define groups; individual fields keep labels. Identity subsections use shared headings. The node dashboard inherits the shared cards. |
| Networking | Addresses and Publish subsections use shared headings; plugin/card titles and action disclosures retain their roles. |
| Backup and restore | Restore overrides use a shared heading; workflow titles, progress messages, and confirmation warnings retain their roles. |
| Preferences | Page-level groups use the shared h2 variant; individual setting cards retain their card titles. |
| Desktop server assistant | Restore-source/mode legends, destination sections, and startup preferences use the same shared component. |
| Desktop client assistant | Connect/register/reset and SSH unlock are single-group forms; card titles, step titles and field labels retain their roles. |
| Native mobile | Connect, sign-in, new subshell and prompt entry use field labels without nested form sections; list headings and screen titles retain their roles. |
| Workspace, sharing, plugin install/remove, search and small action dialogs | Single-group forms keep their existing dialog/card titles; no redundant section headings added. |

Regression tests exercise both semantic headings and named fieldsets. The server
and node stylesheets scan the shared component's package so its layout utilities
are included in production CSS as well as development.

## Browser verification, 2026-10-21

Cua Driver exercised the hot-reload SPA on `localhost:5174`, backed by the
isolated development server on port 3199, in a separate Chromium profile.
A follow-up used a second disposable server on port 3299 for first-run, member-account,
import and remote-node fixtures. This is browser coverage, separate from the source audit above. It does not
establish that every native screen or every conditional state was tested.

| Surface opened | Checks |
| --- | --- |
| Sign-in; profile, passkey-name and password forms | Sign-in completed; labels and initial disabled states inspected. No credentials or passkeys changed. |
| Preferences; general settings | Section hierarchy, setting labels and helper text inspected; lockdown confirmation opened and cancelled. |
| Add user; reset password; disable account | Disposable member created successfully. Reset-password fields and disable confirmation inspected and cancelled. |
| First-run setup | All five steps opened; admin account created, network/tmux/agent steps inspected, final launch form inspected and skipped. |
| Add provider; configure E-mail provider | Provider setup legend, credential fields and permission controls inspected; last-provider restrictions visible. Draft cancelled. |
| Create API key | Empty-name state inspected; cancelled without creating a key. |
| Plugin install and uninstall | Install fields inspected; uninstall options opened and cancelled. |
| Networking | Address fields and Cloudflare, Headscale, NetBird and Tailscale disclosures opened. No installation, publish or disconnect submitted. |
| Backup and restore source | Encryption fields revealed; test backup created successfully. Both restore-source choices opened. |
| Prompt create/edit; stack create/edit | Temporary prompt and stack saved and reopened; inline picker and custom-prompt section inspected. Test records deleted. |
| Preset create/edit/clone/import/share | Paste/custom commands and bulk-variable entry opened; launch defaults and cross-agent notes inspected. Notes persisted after reopening. Temporary preset deleted. |
| SSH preset and SSH launch | Authentication choices and local, remote and SOCKS forward fields opened. Populated SSH import reviewed, refusal displayed with outgoing SSH disabled, then canonical fixture imported successfully with SSH enabled. Saved editor reopened. View-only grant saved and read-only details verified while signed in as the member. No SSH connection started. |
| Node enrollment and remote-node settings | Setup key generated; terminal and desktop enrollment instructions inspected. A real isolated node daemon enrolled. Re-registration confirmation and generated-key fields inspected; service page showed unsupervised restrictions. After stopping the fixture daemon and refreshing, overview displayed offline status with relative last-seen time. |
| Node detail | Combined OS facts, SSH toggle and its conditional control, rename, sharing, allowed-directory editor and guidance inspected. SSH policy restored. Earlier Cua pass also verified recommendation add/remove and both maintenance confirmations. |
| Workspace create/rename and add-subshell | Empty workspace created and renamed; existing/new subshell choices and save-as-preset field opened. |
| Standalone subshell launch | Preset application and expanded agent settings inspected; temporary plain terminal launched through the workspace form. |
| Subshell title, clone, sharing, switch-preset and insert-prompt | Dialogs opened; saved prompt selected and insertion preview inspected without inserting. Temporary terminal closed; empty workspace retired automatically. |

The inspected A3 sections retain compact titles and trailing rules, with labels
and captions visually distinct. This pass found no new section-hierarchy issue.
Screenshots and semantic snapshots were captured under `/tmp/cua-form-audit`;
these are temporary local artifacts, not a checked-in regression suite.

Remaining GUI coverage includes SSH key signing, destination-identity approval and
SSH-based installation, network publishing after installation, native
desktop/mobile forms, and restore configuration. Cua refused the test archive
download because its download tool requires MCP-host approval. Supervised
service/update actions were unavailable on these unsupervised development
processes. The Wayland compositor refused window resizing, so this run does not
establish narrow-screen coverage. There is no separate self-registration form
in the current SPA; account creation is covered through setup and Add user.

Follow-up review corrected the first-run launch subtitle: it now asks the user
to choose the launch settings instead of claiming the fields are prefilled.
The offline observation happened in a background browser tab. Node detail polls
every five seconds while visible and intentionally pauses background polling,
so this observation does not establish a live-update defect. Reloading confirmed
the offline rendering and last-seen text.

The follow-up also fixed a transient unavailable-machine alert while the SSH
preset editor was still loading its machine list. Missing-machine feedback now
waits for a successful readiness read. No new A3 hierarchy defect was found in the inspected forms.
