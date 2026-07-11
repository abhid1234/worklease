# Product spec — Issue #3: `worklease check` (overlap with active claims)

## Problem / motivation
`check` is the heart of worklease. Before an agent edits, it asks: *does my
planned work overlap any live claim held by another agent?* If yes, the agent
can pick different work, wait, or coordinate — and the merge conflict /
duplicated feature never happens. The make-or-break piece is a precise,
zero-dependency **glob-intersection** function: given two globs from the
committed subset (`**`, `*`, literals — pinned by schema issue #1), does *any*
concrete path match both? Everything else in `check` is filtering the registry
down to the claims that actually matter and assembling a clear answer.

## Desired behavior
`worklease check <globs...>` takes one or more planned-edit globs and reports
whether they overlap any **active** claim held by **another** agent.

Output shape (also the return value of the library core):
```json
{
  "clear": true,
  "conflicts": [
    { "claim": { /* the full claim record */ },
      "overlapping_globs": ["src/auth/**"] }
  ]
}
```
- `clear` — `true` iff `conflicts` is empty.
- `conflicts` — one entry per active other-agent claim that overlaps the planned
  edit. `claim` is the full registry claim record. `overlapping_globs` is the
  subset of **that claim's** globs which intersect at least one planned glob
  (deduped, sorted) — i.e. exactly the reservations the checking agent would
  collide with, so it knows what to steer clear of.

CLI:
- Prints a human-readable summary by default (clear ✓, or each conflicting
  agent + intent + overlapping globs).
- `--json` emits the object above verbatim for harness consumption.
- `--agent <id>` (or env `WORKLEASE_AGENT`) identifies "me" so my own claims are
  treated as clear. If no agent is given, no same-agent filtering is applied
  (every active claim is treated as another agent's — the safe default).
- `--registry <path>` overrides the registry file location (default per #4).
- Exit code: `0` when `clear`, `1` when any conflict is found. This is an
  advisory signal a pre-edit hook can gate on; it is **not** a hard lock.

### Glob-overlap semantics (the locked decision)
Two globs **overlap** iff **there exists at least one concrete file path that
matches both** — the *conservative / satisfiability* rule, evaluated purely over
the glob syntax with **no filesystem access**. This is the safe answer for a
check that runs *before* the edit, when the file may not exist yet.

Precise rules for the committed subset (matching #1's syntax; intersection is
this issue's job):
- A glob is a `/`-separated sequence of **segments**.
- A segment equal to exactly `**` matches **zero or more** whole path segments.
- Any other segment matches **exactly one** path segment; within it `*` matches
  any run of characters (including empty) but never crosses `/`. Runs of `*`
  inside a single segment (e.g. `a**b`) collapse to a single `*` — `**` only has
  its cross-segment meaning when it is the *entire* segment.
- Literal characters match themselves, **case-sensitively**. No special-casing
  of dotfiles (`*` matches names beginning with `.`), which keeps the rule
  conservative (never *under*-reports overlap).
- Overlap is symmetric: `overlap(a, b) === overlap(b, a)`.

Worked examples that MUST hold (from the issue):
- `src/auth/**` overlaps `src/**/*.ts` → **true** (e.g. `src/auth/login.ts`).
- `config.js` overlaps `**/*.js` → **true**.
- `src/auth/**` overlaps `src/api/**` → **false** (no shared path).
- `src/*.ts` overlaps `src/auth/*.ts` → **false** (`*` never crosses `/`).
- `**` overlaps anything → **true**; `foo.js` overlaps `foo.js` → **true**;
  `a.js` overlaps `b.js` → **false**.

### Which claims `check` considers
From the full registry, `check` keeps a claim only if **all** of:
1. `status === "active"`, **and** its `expires` is still in the future (a claim
   past its TTL is treated as clear even if it was never explicitly released —
   matches the roadmap "expired = clear, with a warning" lean; released/expired
   status values are likewise skipped).
2. Its `agent` differs from the caller's `--agent`/`WORKLEASE_AGENT` (a
   same-agent claim counts as **clear** — recommended in the issue: you are
   allowed to touch what you already hold).

A claim that passes both filters and whose globs intersect the planned edit
becomes a conflict.

## Acceptance criteria
- [ ] A pure, exported `globsOverlap(globA, globB)` returns a boolean using the
      satisfiability rule above, zero runtime dependencies, no filesystem
      access, and is symmetric.
- [ ] `globsOverlap` passes a documented test matrix covering: identical
      literals, disjoint literals, `*` within a segment, `*` not crossing `/`,
      `**` spanning zero and many segments, `**` at start/middle/end, `**` vs
      `**`, and every worked example above.
- [ ] A pure, exported `check(plannedGlobs, registry, opts)` returns
      `{ clear, conflicts }` exactly as specified, where `opts` carries `agent`
      and an injected `now` (for deterministic expiry evaluation).
- [ ] Only `active`, non-expired, other-agent claims are considered; released,
      expired-by-status, expired-by-time, and same-agent claims are ignored.
- [ ] Each conflict's `overlapping_globs` is the deduped, sorted subset of the
      claim's globs that intersect at least one planned glob.
- [ ] `clear` is `true` iff `conflicts` is empty; an empty registry / no active
      other-agent claims returns `{ clear: true, conflicts: [] }`.
- [ ] `worklease check <globs...>` loads the registry, resolves active claims,
      prints a readable summary, supports `--json`, `--agent`, and
      `--registry`, and exits `0` (clear) / `1` (conflict).
- [ ] `--json` output is parseable and equals the library return value.
- [ ] `npm test` passes with unit tests for `globsOverlap`, `check`, and the CLI.

## Non-goals
- **Not** filesystem-aware matching — `check` never lists or stats real files;
  overlap is decided purely from the glob strings (the concrete-file-evidence
  alternative is explicitly rejected below).
- **Not** the registry engine — append-only JSONL, hash-chaining, and TTL
  expiry live in registry issue #4. `check` consumes a parsed/resolved registry
  array; the CLI reads the registry file (see TECH for the interim loader).
- **Not** claim creation or release (`claim` #2 / `release` #4).
- **Not** validating claim shape — that is `validateClaim` (#1); `check` assumes
  a well-formed registry (and can reuse #1's validator at load time).
- **Not** enforcement — overlap is advisory; the non-zero exit is a hint a
  harness *may* act on, not a lock.
- **Not** extending the glob syntax beyond #1's subset (no `?`, `[]`, `{}`,
  brace-expansion, or extglob).

## Open questions (for the human gate)
Written around the recommended answers; a reviewer may overrule:
- **Overlap semantics — conservative (chosen) vs. concrete-file evidence.**
  Chosen: any path could match both, no FS access. Rationale: `check` runs
  before the edit and must be deterministic and safe; concrete-file evidence
  would miss not-yet-created files and couple the core to a working tree.
- **Same-agent claim = clear (chosen) vs. still reported.** Chosen: clear, per
  the issue. Requires the caller to pass its agent id; if omitted, every active
  claim is treated as another agent's (safe over-report).
- **Exit code on conflict — `1` (chosen) vs. always `0` (pure advisory).**
  Chosen: `1`, so a pre-edit hook can gate; documented as advisory, not a lock.
