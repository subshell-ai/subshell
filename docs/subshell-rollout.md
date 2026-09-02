# Live-host rollout: mote → subshell (clean cut)

Run this after merging `rename/subshell` (or main once merged). It migrates THIS
host's systemd deployment, data dirs, and enrolled nodes. There are no
compatibility shims: the old names are gone from the code, so the deployment
must move in one pass.

**Read first:**

- Do this from a **plain shell / SSH session**, not from a Subshell-managed pane —
  step 4 kills every harness pane (tmux sockets are renamed `mote-<hash>` →
  `subshell-<hash>`; the new backend cannot attach old sockets, so running panes
  end here. Accepted, per the rename spec).
- The last step renames the repo directory — nothing can be running with that cwd.
- Keep old units stopped but their files readable until step 12 smoke passes.

1. **Build fresh artifacts** (repo root):

   ```bash
   bun install && bunx turbo build
   ```

2. **Stop the control plane and any host agent:**

   ```bash
   systemctl --user stop mote.service
   systemctl --user stop mote-agent.service 2>/dev/null || launchctl remove dev.mote.agent 2>/dev/null || true
   ```

3. **Kill orphaned tmux servers** (all harness panes die — accepted):

   ```bash
   tmux ls 2>/dev/null; pkill -f 'tmux.*mote-' || true
   ```

4. **Migrate the server data dir and DB name:**

   ```bash
   mv ~/.config/mote ~/.config/subshell
   mv ~/.config/subshell/mote.db ~/.config/subshell/subshell.db
   mv ~/.config/subshell/mote.db-wal ~/.config/subshell/subshell.db-wal 2>/dev/null || true
   mv ~/.config/subshell/mote.db-shm ~/.config/subshell/subshell.db-shm 2>/dev/null || true
   ```

5. **Reset E2EE/identity stores** (they re-mint on next boot; channel history
   sealed to the old identities becomes unreadable — accepted clean cut):

   ```bash
   rm -rf ~/.local/share/mote
   ```

6. **Rewrite `MOTE_*` in every env file the service reads** (the unit's
   `EnvironmentFile` under `~/.config/subshell/`, plus any local `.env`):

   ```bash
   grep -rl "MOTE_\|mote\.db\|\.config/mote\|mote\.service" ~/.config/subshell .env* 2>/dev/null \
     | xargs -r sed -i -e 's/MOTE_/SUBSHELL_/g' -e 's/mote\.db/subshell.db/g' \
         -e 's|\.config/mote|/.config/subshell|g' -e 's/mote\.service/subshell-server.service/g'
   ```

7. **Fix session working dirs that point at the old repo path** (run AFTER step 11's
   directory rename if you prefer; shown now for the live DB):

   ```bash
   sqlite3 ~/.config/subshell/subshell.db \
     "UPDATE sessions SET working_dir = replace(working_dir, '/home/theo/projects/mote', '/home/theo/projects/subshell') WHERE working_dir LIKE '/home/theo/projects/mote%';"
   ```

8. **Drop old-prefix API keys** — the bearer validation now requires `subshell_`,
   so every stored `mote_` key is dead weight (session keys re-mint on session
   start; system keys you re-create in Settings → System API keys):

   ```bash
   sqlite3 ~/.config/subshell/subshell.db '.schema apiKey'   # inspect first
   sqlite3 ~/.config/subshell/subshell.db 'DELETE FROM apiKey;'
   ```
   (`sessions.api_key_id` is a plain text column — no FK — so no reference
   cleanup is needed. Live sessions re-mint their key on restart.)

9. **Install and start the new unit** (svc.sh now writes `subshell-server.service`
   with `DATABASE_PATH=$HOME/.config/subshell/subshell.db`):

   ```bash
   ./svc.sh install
   systemctl --user daemon-reload
   systemctl --user enable --now subshell-server.service
   systemctl --user disable mote.service
   rm -f ~/.config/systemd/user/mote.service
   ```

10. **Re-enroll node hosts**: on each node, run the new enroll command from the
    Nodes page (fresh setup key). The old `mote-agent` binaries still dial in,
    but their rows can be deleted in the Nodes page once the new enrollments
    check out. On a macOS node, `subshell service install` replaces the
    `dev.mote.agent` launchd job — remove the old one first (step 2 covers the
    control-plane host; on the node itself: `launchctl remove dev.mote.agent`).

11. **Rename the repo directory and the Claude memory folder — the only steps that
    must run from OUTSIDE the repo, with no Claude session open in it:**

    ```bash
    cd ~ && mv projects/mote projects/subshell
    mv ~/.claude/projects/-home-theo-projects-mote ~/.claude/projects/-home-theo-projects-subshell
    ```

    The GitHub repo `disaresta-org/mote` was renamed to `disaresta-org/subshell`
    and the local remote URL updated at merge time (plan Task 8) — after step 11,
    `git fetch` from the new directory confirms it.

12. **Smoke test**: sign in (your existing session cookie survives — better-auth
    cookies are baseURL-derived, not brand-derived); create a session; attach the
    terminal pane; in a Claude pane confirm the MCP server registers as
    `subshell` with tools `list_channels`, `create_session`, … (no prefix);
    fire a push notification and confirm the title reads `subshell`.

**Rollback**: there is none in code. Restoring means checking out the pre-rename
commit, moving the data dir/DB names back (steps 4–6 reversed), and reinstalling
`mote.service`. Do step 8's DELETE only once you're confident.
