# Technical spec — Issue #17: git pre-commit hook adapter

## Approach
One new module, `src/adapters/git-hook.js`, plus a `hook` verb group in
`bin/worklease.js`. The adapter adds **no new matching logic**: a staged file is
a concrete (wildcard-free) glob, so "does this staged path fall under an active
claim?" is exactly `check(stagedPaths, registry, opts)` from #3 — the same reuse
`conformance` (#5) leans on. The adapter's own concerns are (a) gathering staged
paths from git, (b) generating the hook script text, and (c) installing /
uninstalling that text idempotently into the git-resolved hooks directory. Git
calls and filesystem writes are pushed to thin injected boundaries so the core is
pure and unit-testable without a real repo; the CLI wires the real `git` runner
and `node:fs`.

## Files / functions to touch

### New: `src/adapters/git-hook.js`
Pure/near-pure core with I/O injected via `opts`:

```
// I/O injected: gitRunner(args) -> string (stdout), fs subset, cwd.

MANAGED_START = "# >>> worklease managed block >>>"
MANAGED_END   = "# <<< worklease managed block <<<"

// (a) Which paths is this commit about to land?
stagedPaths({ git }) ->
  // git diff --cached --name-only -z --diff-filter=ACMRD
  // NUL-split (paths may contain spaces); renames report the destination path;
  // returns [] when nothing is staged.

// (b) Pure check over already-collected staged paths. Thin, deliberate reuse.
checkStagedPaths(paths, registry, opts) ->
  paths.length ? check(paths, registry, opts) : { clear: true, conflicts: [] }

// (c) The generated hook body (single source of truth for install + sample).
hookScript({ strict, registry, agent }) ->
  // "#!/bin/sh" + MANAGED_START ... MANAGED_END, where the block:
  //   - `command -v worklease >/dev/null 2>&1 || exit 0`  (never block if absent)
  //   - runs: worklease hook run [--strict] [--registry P] [--agent A]
  //   - warn mode: `|| true` so a conflict (exit 1 from `run`) never blocks
  //   - strict mode: propagate `run`'s exit so a conflict blocks the commit
  //   - honors WORKLEASE_STRICT=1 as a runtime override (open Q #2)

// (d) Idempotent install/uninstall against existing hook content.
upsertBlock(existing, block) -> newContent   // pure string transform
  // no existing            -> "#!/bin/sh\n\n" + block
  // existing, no block     -> existing (+newline) + block   // preserve user hook
  // existing, has block    -> replace between MANAGED_START/END              // update

removeBlock(existing) -> newContent | null    // pure; null => delete the file
  // strip the managed block; if only a bare shebang remains that we wrote, null

installHook({ strict, registry, agent, git, fs, cwd }) ->
  dir = hooksDir({ git })                       // see below
  path = join(dir, "pre-commit")
  next = upsertBlock(readIfExists(path), hookScript({strict,registry,agent}))
  write(path, next); chmod(path, 0o755)
  return { path, mode: strict ? "strict" : "warn", created: !existed }

uninstallHook({ git, fs, cwd }) -> { path, removed: bool }

hooksDir({ git }) ->
  // `git rev-parse --git-path hooks` — resolves core.hooksPath AND worktrees
  // correctly (a plain .git/hooks join does neither).
```

Design notes:
- `checkStagedPaths` is the "check-on-staged-paths function" the issue names. It
  is intentionally a one-line reuse of `check`; the value the adapter adds is the
  git plumbing around it, not new overlap math.
- Registry default: reuse `defaultRegistryPath()` from `src/registry.js` so the
  hook resolves the same file `check`/`list` do (env `WORKLEASE_REGISTRY` →
  `.worklease/registry.jsonl`). If `--registry` was passed to `install`, bake it
  into the generated script so the hook is self-contained.
- Executable bit: `chmod 0o755` (git ignores non-executable hooks silently — a
  classic "installed but never runs" trap, so set it explicitly and assert it).

### New committed artifact: `src/adapters/git-hook/pre-commit.sample`
The exact `hookScript({ strict:false })` output, committed so users can read/copy
the hook without installing. Kept in sync by a test.

### Changed: `bin/worklease.js`
Add a `hook` command that dispatches on its subcommand, mirroring the existing
`parseXArgs` / `runX` pattern (shared flags: `--registry`, `--agent`, `--json`;
plus `--strict` for install/run):
- `hook install` → `installHook(...)`, print the confirmation line.
- `hook uninstall` → `uninstallHook(...)`.
- `hook run` → `stagedPaths` then `checkStagedPaths`, print the same conflict
  report `runCheck` prints (factor the existing formatter so run/check share it),
  exit `0` in warn mode, `1` in strict mode on conflict.
- Extend `USAGE` with the `hook` verbs. Register `hook` in `main()`.
- The real `gitRunner` wraps `spawnSync("git", args, { cwd })`; used only in the
  CLI, keeping the module pure for tests.

### Changed: `src/index.js`
Export the adapter's public surface (`checkStagedPaths`, `hookScript`,
`installHook`, `uninstallHook`, `stagedPaths`) so a harness can import it, matching
how the other cores are re-exported.

### Changed: `README.md`
A short "git hook adapter" section: `worklease hook install`, warn vs
`--strict`, `WORKLEASE_AGENT`, and `--no-verify` as the escape hatch.

## Test plan (`npm test` → `node --test`)

New `test/adapters/git-hook.test.js` (unit, pure — inject a fake `git` runner and
a temp dir):
- `checkStagedPaths`: overlap with another agent's active claim → conflict; own
  claim / expired / released → clear; empty paths → clear.
- `stagedPaths`: parses NUL-separated output, includes A/C/M/R/D, `[]` when empty.
- `hookScript`: warn variant ends the invocation with `|| true`; strict variant
  propagates the exit; both include the `command -v worklease || exit 0` guard
  and the managed markers.
- `upsertBlock`: fresh, preserve-existing (user lines survive), replace-existing;
  re-applying the same block is idempotent (byte-identical).
- `removeBlock`: strips only the managed block; returns `null` for a file that is
  just our shebang + block.
- `hooksDir`: uses the injected `git rev-parse --git-path hooks` value (prove
  `core.hooksPath` is honored, not `.git/hooks`).
- Sample-in-sync: committed `pre-commit.sample` equals `hookScript({strict:false})`.

New `test/hook.test.js` (CLI e2e via `spawnSync`, in a real temp `git init` repo,
following `test/cli.test.js` conventions):
- `hook install` writes an executable pre-commit hook containing the markers;
  second install is byte-identical; a pre-seeded user hook's lines survive.
- Stage a file under another agent's active claim, then run the installed hook
  (or `hook run`): warn mode prints the conflict and exits `0`; `--strict` exits
  `1`. Own-agent claim → clear/exit 0.
- Hook with `worklease` absent from `PATH` → exits `0` (never blocks).
- `hook uninstall` removes the block and restores the prior file / deletes a
  worklease-only file.

## Risks / edge cases / migrations
- **Blocking a developer (strict).** Mitigated: warn is the default; strict is
  opt-in and always bypassable with `git commit --no-verify` (documented).
- **Clobbering an existing hook.** Mitigated by the managed-block upsert — user
  content is never rewritten; only the marked block is touched.
- **`core.hooksPath` / worktrees.** A hard-coded `.git/hooks` would install where
  the hook never runs. Resolve via `git rev-parse --git-path hooks`. Dogfood runs
  on Conductor worktrees, so this must be right.
- **`worklease` not on PATH when the hook fires** (e.g. only `npx`/node
  available). The hook guards with `command -v worklease || exit 0` and never
  blocks on a missing tool; README notes how to make it resolvable.
- **Missing registry.** `check` already treats a missing registry as clear — the
  hook inherits that; no error.
- **Paths with spaces / non-ASCII.** Use `-z` (NUL-separated) `git diff --cached`;
  never split on plain newlines.
- **Non-executable hook.** Git silently skips it — set and assert `0o755`.
- **No migration.** Additive: a new module, a new committed sample, a new CLI
  verb group. No schema, registry, or existing-command changes.

## Alternatives considered
- **Block-by-default** — rejected; violates design principle #1 (advisory).
- **pre-edit / editor hook first** — that's roadmap #7 (git has no pre-edit
  hook); pre-commit is the git-native gate and this issue's stated scope.
- **Logic inlined in the shell hook** — rejected; keeping logic in `hook run`
  (JS) makes it testable and keeps the shell file a thin, portable wrapper.
- **A second overlap implementation for staged paths** — rejected; a concrete
  path is a wildcard-free glob, so `check` already answers it (same reuse as #5).
- **Global `core.hooksPath` template install** — deferred; per-repo install is
  simpler and sufficient for v0.2 dogfooding.
- **Sample as a hand-maintained file** — rejected; generate it from
  `hookScript()` and test the equality so it can't drift.
