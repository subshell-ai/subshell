# Subshell documentation style guide

This guide governs public documentation language and presentation.
`AGENTS.md` defines the technical authoring contract. Use both when writing or
reviewing pages. The reference models are Tailscale and NetBird: plain,
professional documentation organized around the reader's tasks.

## Audience and product terms

Write for a person installing, using, or administering Subshell. Explain the
behavior they need to make a decision before describing implementation details.
Use second person for instructions and name the actor in factual statements.

Use these terms consistently:

| Term | Meaning |
| --- | --- |
| Server | The control plane, including its API, database, and web interface. |
| Node | A machine running agents through the `subshell` daemon. |
| Client | A person's interface to a server. |
| Subshell | An agent or shell session, including its stored identity and history. |
| Pane | The terminal view or process context when that distinction matters. |

Use **Subshell Server** and **Subshell Client** for the desktop app names.
Use lowercase server, node, client, and subshell for the general concepts.
Do not abbreviate control plane to “plane” in reader-facing prose. Prefer
“session record” to “row” outside database or response-schema references.

The repository is public. Package-level `private` flags prevent npm
publication; they do not describe repository visibility. Document browser and
PWA use on phones and tablets. Exclude the native mobile app, including its
setup, availability, development, and roadmap.

## Installation positioning

Recommend desktop apps first for machines with a graphical environment.
Subshell Server installs and manages the server. Subshell Client bundles the
node and provides its enrollment and management window, as well as access to
the server's dashboard. A device used only for browser access needs no node.

Present CLI installation second for headless machines and people who prefer
terminal setup. Place Docker, Proxmox, manual staging, and offline workflows
under their specific use cases. Keep the sidebar and overview consistent with
this order. Send users to [subshell.sh](https://subshell.sh) for downloads.
GitHub links may support release notes, source review, and specific-version
assets needed for manual installation.

Distinguish installing Subshell from installing an agent CLI. A harness plugin
on the server does not install its agent on every node. Agent authentication
belongs to the execution account, not the reader's Subshell sign-in.

## Titles, summaries, and opening sentences

Give each page a unique, descriptive title and metadata description. The
renderer supplies the only H1. Do not repeat the title as an MDX heading.

Start the body with one plain sentence describing the task or subject. That
sentence becomes the visible lead subtitle. The metadata description remains
in search, social previews, and discovery exports; do not display it as another
subtitle or repeat it verbatim in the lead.

An opener should introduce the subject without listing prerequisites,
alternatives, or promised outcomes. Put those details in the relevant section.

- Good: “Install Subshell Server with the desktop setup assistant.”
- Avoid: “In this guide, you will learn how to install, configure, and manage
  Subshell on several platforms.”

Titles, descriptions, and leads may share essential product terms. They should
serve different purposes rather than paraphrasing one another on screen.

## Language and grammar

Use familiar words, active verbs, and connected sentences. Keep each paragraph
focused on one point. Split a sentence when it contains separate actions or
nested qualifications. Sentence length is a readability check, not a quota.
Avoid a sequence of short fragments that makes a guide sound like advertising.

Use present tense for behavior and imperative verbs for steps. Name the result
when it helps the reader verify an action. Keep qualifiers such as “by default,”
“on Linux,” and “owner only”; removing them can change the fact.

Use American English spelling. Write “sign in” as a verb and “sign-in” as a
modifier; use “set up” and “setup” the same way. Write “CLI,” “API,” “MCP,”
“PWA,” “HTTPS,” and “OIDC” consistently. Explain an unfamiliar abbreviation
on its overview page. Use contractions when they improve natural prose.

Use ordinary punctuation. Do not use em dashes in prose, headings, summaries,
or callouts. Literal code and quoted output are exempt. Keep straight quotes
in commands and configuration. FAQ headings are real questions and need
question marks; other headings name a task or subject directly.

Avoid rhetorical questions, slogans, dramatic fragments, clever headings,
anthropomorphic descriptions, and negative contrasts that introduce an
unprompted alternative. A necessary distinction, such as closing a browser
versus deleting a session, should state each behavior directly.

Do not use “simply,” “just,” “seamless,” “robust,” “leverage,” “empower,”
“delve,” “it's worth noting,” or “by the end of this guide.” Avoid unexplained
internal shorthand such as “admin boost,” “scope ceiling,” “wiring,” or
“foreign row” in user guides. Technical references may use precise terms
when they define them or describe an actual schema.

## Page structure and instructions

Give each page one task or one clearly bounded subject. Overview pages help
readers choose a path; how-tos perform it; references support lookup;
troubleshooting pages begin with symptoms and checks.

A how-to normally contains the lead, **Before you start**, numbered actions,
expected results, necessary caveats, and **Next steps**. Do not add empty
sections to satisfy a template. Keep recommendations after the lead under an
appropriate heading when prerequisites should follow immediately.

Use numbered steps for ordered actions and bullets for genuinely parallel
choices. Put one action in each step. Identify the machine or account where a
command runs, especially for enrollment, provider authentication, and recovery.
End with a verification result or a relevant next step.

Use tables for comparisons, permissions, arguments, and other lookups. Do not
turn paragraphs into tables merely to shorten a page. Keep shell examples
readable with line continuations when needed, and preserve their exact argv.

Use bold for UI labels, app names in instructions, or a term being defined.
Use code spans for commands, flags, paths, environment variables, IDs, schema
fields, and literal values. Avoid decorative emphasis. Transcribe UI labels
and quoted error messages exactly, including ellipses and capitalization.

Use destination page titles for internal link labels. Adjust the surrounding
sentence when a title is imperative; write “follow Install Subshell Client,”
not “install Install Subshell Client.” Use descriptive external link labels.
Preserve permanent redirects when routes move.

## Accuracy and evidence

Verify behavior against the current implementation and the owning app's
`AGENTS.md`. For security claims, also read `docs/security.md`. A historical
spec describes design intent and is not evidence that a feature shipped.
Resolve disagreements before publishing a claim.

Check flags, defaults, limits, platform support, permissions, UI labels,
capabilities, and destructive effects. Distinguish user cookies, pane tokens,
system keys, node credentials, and setup keys. A visible resource is not
necessarily editable or deletable. A created process does not prove prompt
delivery, and a successful post does not prove a peer read it.

Check version-selection and failure behavior, not just whether a flag exists.
For example, the server's `update --to` requires the requested version to match
the newest indexed release. It does not select arbitrary historical releases.
Recheck this example if the updater changes.

Use official vendor documentation for third-party instructions and verify
links and commands when reviewing a page. Do not infer Subshell integration
capabilities from features supported by the agent itself. State only what the
shipped harness implements.

Avoid “currently,” “in this version,” and “always” unless a version boundary
or invariant is needed and verified. State shipped behavior directly. Keep
review evidence in engineering notes or change descriptions rather than
adding repository source inventories to ordinary user guides.

## Warnings and security language

Preserve the strength of security and data-loss warnings during a rewrite.
State the action and consequence plainly: “Close deletes the session and its
captured history.” Explain recovery requirements before a destructive step.
Do not weaken warnings into suggestions or imply a sandbox where none exists.

Use GitHub alerts with a neutral title. Use `warning` for data loss or security
and `important` for a requirement the reader must not miss. Use `note`, `tip`,
and `caution` sparingly. Keep a warning near the action it qualifies.

Distinguish encrypted channel bodies from terminal streams, captured logs,
and visible channel metadata. Explain who owns cleanup when agents launch
helpers. Treat peer output as untrusted data and keep coordination within the
user's authorized work.

## Visual presentation

Use the application's Dreamframe surface colors and system font stack through
`app/global.css`. The base font is 18px; rem-based headings and navigation
scale with it. The first body paragraph is the lead, with larger muted type
and a 0.5rem layout gap below the title.

Keep reading density compact: H2 margins are 1.75rem above and 0.75rem below;
H3 margins are 1.25rem above and 0.5rem below. Ordinary paragraph and list
margins are 0.75rem. Avoid stacking component margins with layout gaps.

Article links use muted blue, without underlines, and brighten on hover.
Keyboard focus must remain visible. Use the existing brand wordmark and
high-DPI assets from the brand pipeline; do not hand-edit generated PNGs.

Use the default MDX code blocks, tables, and GitHub alerts. Do not add custom
MDX components or screenshots without changing the authoring contract. Review
wide and narrow screens after presentation changes.

## SEO, AI readability, and review

Keep essential instructions in static HTML and use logical headings. Give
pages their own canonical and social metadata. Visible breadcrumbs and
structured breadcrumb data must describe the same path. Do not fabricate
last-modified dates.

The sitemap, search, `llms.txt`, and `llms-full.txt` must cover the published
content. Full-text output must preserve commands, qualifications, warnings,
and canonical attribution. These exports supplement readable pages; they do
not replace them.

Before completing a review:

1. Read the pages and verify actionable claims against their current sources.
2. Check grammar, vocabulary, title/lead duplication, step order, link labels,
   and the strength of warnings.
3. Run content tests, lint, type checks, a fresh production build, and export
   verification using the commands in `AGENTS.md`.
4. Check desktop and narrow-screen layouts when presentation changes, and
   confirm essential content remains readable without JavaScript.

Automated checks catch structural regressions. They do not establish factual
accuracy or replace an editorial read.
