// worklease — git pre-commit hook adapter (the dogfood surface).
//
// This is what makes worklease actually prevent collisions in a live
// parallel-agent setup: a pre-commit hook that runs `worklease check` on the
// files a commit is about to change and surfaces any overlap with another
// agent's active claim. The git plumbing lives here; the coordination decision
// is delegated to the existing pure `check` core, so this adapter adds a new
// *surface*, not a second notion of "conflict".
//
// Design, matching roadmap principle #1 ("advisory, not enforcing"): the hook
// is warn-only by default (prints conflicts, exits 0, never blocks a commit).
// `worklease hook install --strict` bakes in blocking mode, where a conflict
// exits 1 and git aborts the commit. Both modes run the same `hook run` verb;
// the only difference is whether a conflict is fatal.
//
// Zero runtime dependencies: `git` is invoked via `child_process`, everything
// else reuses this package's own modules.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { loadRegistry, defaultRegistryPath } from "../registry.js";
import { check } from "../check.js";

// Markers delimiting worklease's managed region inside `.git/hooks/pre-commit`.
// Install rewrites only the text *between* (and including) these lines, so any
// pre-existing hook body a user or another tool wrote is preserved verbatim.
const START = "# >>> worklease >>>";
const END = "# <<< worklease <<<";

// --- staged-path check (the check-on-staged-paths function) ----------------

// stagedPaths({ cwd }) → the repo-relative paths staged for the pending commit.
//
// These are the "files about to change". A staged path is already a concrete
// path, and every concrete path is a valid glob in the committed subset (a
// literal), so the paths feed straight into `check` — `check("src/auth/x.ts",
// …)` overlaps a claim on `src/auth/**`. No path→glob translation is needed.
// A non-git directory (or any git failure) yields [] — the caller then treats
// the commit as clear, since an advisory hook must never wedge a commit.
export function stagedPaths(opts = {}) {
  const { cwd = process.cwd() } = opts;
  // `-z` gives NUL-terminated, UNQUOTED paths. Without it, git quotes unusual
  // names and a filename may legally contain a newline — either of which would
  // split/mangle a path and let a staged file slip past its claim. Split on NUL
  // and do NOT trim (leading/trailing spaces are valid path characters).
  const r = spawnSync("git", ["diff", "--cached", "--name-only", "-z"], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0 || typeof r.stdout !== "string") return [];
  return r.stdout.split("\0").filter((p) => p.length > 0);
}

// checkStagedPaths(paths, { registry, agent, now }) → { clear, conflicts, notes }
//
// The core the hook runs: load the registry once and run the shared `check`
// core over the staged paths. Empty input short-circuits to clear (an empty or
// docs-only commit can never collide). `notes` carries loadRegistry's
// skipped/tampered/expired warnings so the caller can surface them — a dropped
// line means `check` might call a held path clear, the exact collision this
// tool exists to catch.
export function checkStagedPaths(paths, opts = {}) {
  const { registry = null, agent = null, now = Date.now() } = opts;
  if (!paths || paths.length === 0) {
    return { clear: true, conflicts: [], notes: [] };
  }
  const path = registry || defaultRegistryPath();
  const { claims, notes } = loadRegistry(path, { now });
  const result = check(paths, claims, { agent, now });
  return { clear: result.clear, conflicts: result.conflicts, notes };
}

// --- hook install ----------------------------------------------------------

// gitPath(cwd, rel) → the absolute path of a file inside the git dir, or null
// if cwd is not a git repo. Uses `git rev-parse --git-path` so it resolves
// correctly for worktrees (where hooks live in the shared common dir) — the
// exact setup worklease targets, since fleets run in parallel worktrees.
function gitPath(cwd, rel) {
  const r = spawnSync("git", ["rev-parse", "--git-path", rel], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  const p = r.stdout.trim();
  if (!p) return null;
  return isAbsolute(p) ? p : join(cwd, p);
}

// hookPath(cwd) → absolute path of this repo's pre-commit hook, or null if cwd
// is not a git repository.
export function hookPath(cwd = process.cwd()) {
  return gitPath(cwd, "hooks/pre-commit");
}

// renderHookBlock(strict) → the marker-delimited shell block install writes.
//
// The block delegates to `worklease hook run`, guarded by `command -v` so a
// clone where `worklease` isn't on PATH degrades gracefully (no hook error,
// consistent with advisory-first). The strict/warn policy lives entirely in
// `hook run`; install just chooses whether to pass `--strict`, keeping the
// exit-code decision in one place.
export function renderHookBlock(strict = false) {
  return [
    START,
    "# Managed by `worklease hook install` — runs `worklease check` on staged files.",
    strict
      ? "# Mode: strict — a claim conflict blocks the commit (exit 1)."
      : "# Mode: advisory — conflicts are printed but never block the commit.",
    "if command -v worklease >/dev/null 2>&1; then",
    strict ? "  worklease hook run --strict" : "  worklease hook run",
    "fi",
    END,
  ].join("\n");
}

// installHook({ cwd, strict }) → { path, action, strict }
//
// Idempotent, existing-hook-preserving install:
//   - no pre-commit hook yet         → create one (shebang + block)  ["created"]
//   - a hook with our markers        → replace only the marked block ["updated"]
//   - a hook without our markers      → append the block after it     ["appended"]
// Re-running install therefore converges to a single managed block and never
// duplicates it or clobbers a hand-written hook. The file is chmod +x so git
// will execute it.
export function installHook(opts = {}) {
  const { cwd = process.cwd(), strict = false } = opts;
  const path = hookPath(cwd);
  if (!path) {
    throw new Error("not a git repository (run `git init` first)");
  }

  const block = renderHookBlock(strict);
  let content;
  let action;

  if (!existsSync(path)) {
    content = `#!/bin/sh\n${block}\n`;
    action = "created";
  } else {
    const existing = readFileSync(path, "utf8");
    const startCount = existing.split(START).length - 1;
    const endCount = existing.split(END).length - 1;
    const s = existing.indexOf(START);
    const e = existing.indexOf(END);
    if (startCount === 0 && endCount === 0) {
      const sep = existing.endsWith("\n") ? "" : "\n";
      content = `${existing}${sep}\n${block}\n`;
      action = "appended";
    } else if (startCount === 1 && endCount === 1 && e > s) {
      content = existing.slice(0, s) + block + existing.slice(e + END.length);
      action = "updated";
    } else {
      // Unbalanced or duplicated markers = a malformed managed region. Appending
      // would let the next install pair a stale marker with a fresh one and
      // delete the user's content between them. Fail safely and ask for a repair.
      throw new Error(
        "pre-commit hook has a malformed worklease managed region (unbalanced or duplicate markers); " +
          "remove the lines between and including the worklease markers, then re-run `worklease hook install`."
      );
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return { path, action, strict };
}
