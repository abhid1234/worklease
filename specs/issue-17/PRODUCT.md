# Product spec — Issue #17: git pre-commit hook adapter (dogfood)

## Problem / motivation
worklease already lets an agent `claim` globs and `check` before it edits — but
today nothing *makes* an agent check. In the author's live fleet (parallel
factory workers + Conductor Claude Codes sharing a repo), an agent will happily
edit a file another agent is holding because nothing sits between "about to
write" and the registry. The git pre-commit hook is the dogfood wedge: it runs
`check` automatically on the files a commit is about to land and surfaces any
overlap with another agent's active claim, so the collision is caught at the one
moment git already gives us a gate. This is roadmap item #6 and the vision's
stated first dogfood surface.

## Direction (recommended)
**Warn-only by default; block only under an opt-in `--strict`.** Design
principle #1 is "advisory, not enforcing" — the hook should *inform*, not become
a mutex that hard-locks a developer out of committing. So the default hook prints
any conflicts and exits `0` (the commit proceeds); `worklease hook install
--strict` bakes strict mode in, where a conflict prints the same report and exits
`1` (the commit is blocked). Rejected alternative: block-by-default (violates the
advisory principle and would make the tool feel adversarial on day one).

The git surface is **`pre-commit`** (git's native pre-write gate). The issue
title says "pre-edit / pre-commit"; git has no pre-edit hook, so a true
pre-*edit* check belongs to the Claude Code / editor adapter (roadmap #7). This
spec delivers the git-native surface only and leaves pre-edit to #7.

## Desired behavior

### `worklease hook install [--strict] [--registry <path>] [--agent <id>]`
Installs a managed pre-commit hook into the current repository.
- Resolves the hooks directory via git (honors `core.hooksPath` and worktrees),
  not a hard-coded `.git/hooks`.
- Writes a small POSIX-sh hook that invokes `worklease hook run` with the chosen
  flags. All real logic stays in the CLI (testable JS); the shell file is a thin
  wrapper.
- **Idempotent and non-destructive.** The hook content lives inside a clearly
  marked managed block:
  ```sh
  # >>> worklease managed block >>>
  ...
  # <<< worklease managed block <<<
  ```
  - No existing `pre-commit` hook → create one (shebang + managed block),
    executable.
  - Existing hook with **no** worklease block → append the managed block,
    preserving every existing line.
  - Existing hook **with** a worklease block → replace just that block (this is
    how flags like `--strict` are updated). Re-running with the same flags
    produces a byte-identical file.
- Prints a one-line confirmation naming the hook path and the mode (warn/strict).

### `worklease hook uninstall [--registry <path>]`
Removes only the worklease managed block, leaving any surrounding user hook
content intact. If the file becomes just a bare shebang (we created it), remove
the file. No-op with a note if no worklease block is present.

### `worklease hook run [--strict] [--registry <path>] [--agent <id>]`
The command the installed hook calls (also runnable by hand). It:
1. Collects the paths the commit is about to land — the staged files.
2. Runs `check` on those paths against the registry (own-agent and
   expired/released claims count as clear, exactly as `check` already decides).
3. If clear → print nothing (or a terse "clear" note) and exit `0`.
4. If overlapping → print each conflict (which agent holds it, the intent, when
   it expires — the same report `check` prints), then exit `0` in warn mode or
   `1` in strict mode.
5. No staged paths (e.g. `--allow-empty`) → clear, exit `0`.

### Agent identity in a commit context
"Me" is resolved as: `--agent` → `WORKLEASE_AGENT` → git `user.email`/`user.name`
→ `null`. When identity is unknown, `check` treats every active claim as another
agent's (the safe default) and may warn about the caller's own claims; the hook
documents setting `WORKLEASE_AGENT` per worktree to avoid that.

### Committed sample
A reference `pre-commit` sample is committed under `src/` (so it ships in the
npm `files` allowlist) and is the exact output of the hook-script generator, so
a user can read or hand-copy the hook without running `install`. A test asserts
the committed sample stays in sync with the generator.

## Acceptance criteria
- [ ] `src/adapters/git-hook.js` exports a pure check-on-staged-paths function
      that, given staged paths + a resolved registry, returns the same
      `{ clear, conflicts }` shape `check` returns (reusing the `check` core, not
      a second overlap implementation).
- [ ] `worklease hook install` writes an **executable** pre-commit hook into the
      git-resolved hooks dir (respecting `core.hooksPath` and worktrees).
- [ ] Install is idempotent (second run → byte-identical file) and preserves any
      pre-existing pre-commit hook content (managed-block strategy).
- [ ] Install with `--strict` produces a hook that exits `1` on conflict; without
      it, the hook exits `0` on conflict (warn-only default).
- [ ] `worklease hook run` checks the staged paths and prints the conflict report
      for any overlap with another agent's **active** claim; own / expired /
      released claims and "no staged paths" are clear.
- [ ] The hook never blocks on a missing `worklease` binary or a missing registry
      — it degrades to a warning / clear, exit `0`.
- [ ] `worklease hook uninstall` removes only the managed block and restores the
      prior state.
- [ ] A committed sample hook exists and a test proves it matches the generator.
- [ ] Zero new dependencies; consistent with the existing CLI surface and flags.
- [ ] `npm test` passes, including new adapter unit tests and CLI e2e tests.

## Non-goals
- Not a pre-*edit* hook and not an editor/Claude Code integration — that is
  roadmap #7. This is the git-native surface only.
- Not `pre-push` / `commit-msg` / other git hooks (pre-push may follow later).
- Not auto-`claim` on commit — the hook only `check`s; filing claims stays an
  explicit agent action.
- Not a hard lock even in `--strict`: a developer can always bypass with
  `git commit --no-verify`; strict raises friction, it does not enforce.
- Not a global/template-level install (`git config --global core.hooksPath`) —
  per-repo install only for v0.2.

## Open questions (for the human gate)
1. **Warn vs block default** — spec locks **warn-only default, `--strict`
   opt-in** per design principle #1. Confirm this is the intended default.
2. **Runtime strict override** — should `WORKLEASE_STRICT=1` also flip an
   installed warn-mode hook to blocking at commit time, on top of the baked-in
   flag? Recommend yes (cheap, lets CI block without reinstalling).
3. **Deletions** — should staged *deletions* count as touched paths for the
   overlap check? Recommend yes (deleting a file another agent holds is a real
   collision); spec assumes deletions are included.
