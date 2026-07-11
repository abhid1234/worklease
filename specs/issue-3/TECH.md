# Technical spec — Issue #3: `worklease check` (glob intersection)

## Approach
Two new pure, zero-dependency modules plus a CLI verb. `src/glob.js` is the
crux: a hand-rolled **glob-intersection** function that decides, purely from two
glob strings, whether any concrete path could match both. `src/check.js` is thin
orchestration: filter a registry down to active, non-expired, other-agent claims
and assemble `{ clear, conflicts }` using `globsOverlap`. `bin/worklease.js`
gains a `check` subcommand that loads the registry file, resolves active claims,
calls the core, and prints. Everything stays inside the committed glob subset
from #1 (`**`, `*`, `/`, literals) — the validator (#1) guarantees `check` never
sees `? [ ] { }`, so the intersection code only handles the tokens it commits to.

The intersection is a **pattern-vs-pattern satisfiability** problem (not
pattern-vs-string), solved at two levels — across segments, and within a
segment — each a memoized two-pointer recursion. No FS, no `Date.now()` in the
core (time is injected).

### Level 1 — segment-level overlap `segmentsOverlap(A, B)`
`A`, `B` are arrays of segment tokens (glob split on `/`). A token is either the
literal `"**"` (cross-segment wildcard) or a single-segment pattern string.
Memoize on `(i, j)` (indices into A, B) to keep it O(|A|·|B|); `**`-vs-`**` is
otherwise exponential.

```
overlap(i, j):
  if i == A.length and j == B.length: return true
  if i < A.length and A[i] == "**":
      # ** matches zero segments, or one-or-more (consume a B segment)
      return overlap(i+1, j) or (j < B.length and overlap(i, j+1))
  if j < B.length and B[j] == "**":
      return overlap(i, j+1) or (i < A.length and overlap(i+1, j))
  if i == A.length or j == B.length: return false          # one ran out
  if not segmentOverlap(A[i], B[j]): return false           # this pair can't align
  return overlap(i+1, j+1)                                   # aligned, advance both
```
(When both current tokens are `**`, the first two branches cover it; the order
of the `**` branches is irrelevant to the result.)

### Level 2 — within-segment overlap `segmentOverlap(a, b)`
`a`, `b` are single-segment patterns where `*` matches any run of characters
(including empty) and every other character is a literal. Question: do they
generate a common string? Memoized two-pointer over characters:

```
seg(i, j):
  if i == a.length and j == b.length: return true
  if i < a.length and a[i] == '*':
      return seg(i+1, j) or (j < b.length and seg(i, j+1))   # * eats 0 or 1+ of b
  if j < b.length and b[j] == '*':
      return seg(i, j+1) or (i < a.length and seg(i+1, j))
  if i == a.length or j == b.length: return false
  if a[i] == b[j]: return seg(i+1, j+1)
  return false
```
A common producible string here may be empty only when both sides are `*`-only,
which also produce non-empty strings — so no separate "segment must be
non-empty" guard is needed.

### `globsOverlap(globA, globB)` — public API
1. `normalize(glob)` → segment array:
   - trim a single leading `./`; collapse repeated `/` to one; drop a trailing
     `/` (treat `src/auth/` as `src/auth`); the result splits on `/`.
   - within each non-`**` segment, collapse any run of `*` to a single `*`
     (so `a**b` → `a*b`, and stray `**` adjacent to literals loses cross-segment
     meaning — `**` spans segments only when it is the whole segment).
2. `return segmentsOverlap(normalize(globA), normalize(globB))`.
Symmetric by construction; add a test asserting `overlap(a,b) === overlap(b,a)`.

### `check(plannedGlobs, registry, opts)` — `src/check.js`
`opts = { agent?: string, now?: number }` (`now` defaults to injected epoch ms;
the CLI passes real time, tests pass a fixed value).
```
active = registry.filter(c =>
  c.status === "active" &&
  Date.parse(c.expires) > now &&
  (agent == null || c.agent !== agent))

conflicts = []
for c of active:
  overlapping = c.globs.filter(g => plannedGlobs.some(p => globsOverlap(p, g)))
  if overlapping.length: conflicts.push({ claim: c, overlapping_globs: dedupeSort(overlapping) })

return { clear: conflicts.length === 0, conflicts }
```

### CLI — `bin/worklease.js` `check` subcommand
- Parse: positional `<globs...>`; flags `--agent <id>` (fallback
  `process.env.WORKLEASE_AGENT`), `--registry <path>`, `--json`.
- Load registry: read the registry file, parse the append-only JSONL, and
  **resolve** it to the current claim array. Registry issue #4 owns the loader
  (`loadRegistry`/resolution + default path); until #4 lands, `check` uses a
  small local reader — read the file, `JSON.parse` each non-empty line, keep the
  latest record per `id`, tolerate a missing file as an empty registry. This
  reader is isolated so it can be swapped for #4's without touching the core.
- Call `check(globs, registry, { agent, now: Date.now() })`.
- Print: `--json` → the return object; otherwise a readable summary
  (`clear ✓ — no overlap with N active claims`, or per conflict:
  `⚠ <agent> holds <overlapping_globs> — "<intent>" (expires <…>)`).
- Exit `0` if `clear`, else `1`. No globs given, or unknown flag → usage + exit
  `1`.

## Files / functions to touch
- **`src/glob.js`** (new) — `globsOverlap(a, b)` + helpers `normalize`,
  `segmentsOverlap`, `segmentOverlap`. Pure, no imports.
- **`src/check.js`** (new) — `check(plannedGlobs, registry, opts)`. Imports only
  `globsOverlap` from `./glob.js`.
- **`src/index.js`** (edit) — also re-export `globsOverlap` and `check`
  alongside the existing `validateClaim`/`validateRegistry`.
- **`bin/worklease.js`** (edit) — add the `check` subcommand + the interim JSONL
  registry reader; extend usage text.
- **`test/glob.test.js`** (new) — the intersection matrix.
- **`test/check.test.js`** (new) — filtering + conflict assembly.
- **`test/cli.test.js`** (edit/new) — `check` CLI cases against temp fixtures.
- **`README.md`** (update at implementation time, not in this spec PR) — a short
  `check` usage block.

## Test plan
Run with `npm test` (`node --test`).

**`globsOverlap` (the matrix)**
- Identical literals overlap; disjoint literals (`a.js` vs `b.js`) do not.
- `src/*.ts` vs `src/auth.ts` overlaps; `src/*.ts` vs `src/auth/x.ts` does not
  (`*` never crosses `/`).
- `config.js` vs `**/*.js` → true; `src/auth/**` vs `src/**/*.ts` → true;
  `src/auth/**` vs `src/api/**` → false.
- `**` vs any glob → true; `**` vs `**` → true; `a/**/b` vs `a/b` → true
  (`**` matches zero segments); `a/**/b` vs `a/x/b` → true.
- Trailing slash / `./` / duplicate-slash normalization equivalence.
- `a**b` (in-segment) treated as `a*b` (single segment, no `/` crossing).
- Symmetry: for a sample set, `overlap(a,b) === overlap(b,a)`.
- Performance/termination: deeply nested `**` (e.g. `a/**/**/**/c` vs
  `a/x/y/z/c`) returns quickly (memoization guard).

**`check`**
- Empty registry → `{ clear: true, conflicts: [] }`.
- One active other-agent claim overlapping → one conflict with correct
  `overlapping_globs` (deduped, sorted).
- Same-agent claim (matching `opts.agent`) → clear.
- `status` `released`/`expired` → ignored.
- Active status but `expires <= now` → ignored (expired by time).
- Multiple planned globs; a claim overlapping via any one → conflict.
- A claim with several globs where only some overlap → only those in
  `overlapping_globs`.
- `agent` omitted → all active claims treated as others'.

**CLI (`test/cli.test.js`)**
- Clear check → readable output, exit `0`; `--json` parses to
  `{ clear: true, conflicts: [] }`.
- Conflicting check → exit `1`; `--json` lists the conflict.
- `--agent` filters own claims; `WORKLEASE_AGENT` env has the same effect.
- Missing registry file → treated as empty (clear), exit `0`.
- No globs / unknown flag → usage, exit `1`.

## Risks / edge cases / migrations
- **Exponential blow-up on nested `**`.** Both recursions memoize on index
  pairs, bounding work to O(mn) per level; a test exercises stacked `**`.
- **`**` semantics.** `**` spans segments only as a whole segment; in-segment
  `**` collapses to `*`. Pinned in `normalize` and tested, so `check` and `#1`'s
  validator agree on the subset.
- **Conservative over-reporting is intended.** Because overlap is pure
  satisfiability (dotfiles included, no FS), it may flag a pair that no *current*
  file realizes. That is the safe direction for a pre-edit check; documented as
  a non-goal to be FS-aware.
- **Registry coupling to #4.** `check`'s core takes a resolved array and is
  fully testable now; only the CLI's file reader depends on #4. The interim
  JSONL reader (latest-per-`id`, missing-file = empty) is deliberately minimal
  and swappable, so shipping #3 before #4 does not block, and adopting #4's
  loader later is a localized change.
- **Expiry uses injected time.** The core takes `now`; only the CLI reads the
  clock — keeps tests deterministic and the core pure.
- **No migrations.** Greenfield modules; no persisted data changes.

## Alternatives considered
- **Concrete-file-evidence overlap (glob against the real working tree)** —
  rejected: misses not-yet-created files, non-deterministic, couples the core to
  a filesystem; wrong for a pre-edit check.
- **Regex-compile each glob and test intersection via product automaton** —
  rejected: heavier and harder to keep zero-dep and readable than the two
  memoized recursions; the committed subset is small enough for direct matching.
- **Pattern-vs-sampled-paths (enumerate candidate paths and test membership)** —
  rejected: unbounded/incomplete; satisfiability is exact and cheap here.
- **Same-agent claims still reported** — rejected per the issue: an agent may
  edit what it already holds; reporting them adds noise.
- **Always exit `0` (pure advisory)** — rejected: a non-zero exit lets a
  pre-edit hook gate while staying advisory (no lock); `--json` still returns the
  full result regardless of exit code.
- **Fold `check` into one module with the validator** — rejected: the glob
  intersection is a distinct, heavily-tested concern; its own `src/glob.js`
  keeps the crux isolated and reusable (playground, adapters).
