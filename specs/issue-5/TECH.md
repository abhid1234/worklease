# Technical spec — Issue #5: `worklease conformance`

## Approach
One new pure, zero-dependency module, `src/conformance.js`, plus a CLI verb.
`conformance(claims, merges, opts)` classifies every `(agent, file)` change
against the resolved registry and assembles `{ score, total, respected,
violations, warnings }`. It introduces **no new matching logic**: a touched file
is a concrete (wildcard-free) glob, so "does file `F` fall under claim glob `G`?"
is exactly `globsOverlap(F, G)` from #3 — the "reuses the glob-overlap core"
called for in the issue. The core is pure and deterministic: all time comparisons
use the merge record's own `at` (or fall back to claim `status`), so no
`Date.now()` is needed. `bin/worklease.js` gains a `conformance <registry>
<merges>` subcommand that loads both files, calls the core, and prints.

### `conformance(claims, merges, opts)` — `src/conformance.js`
```
opts = {}                       // reserved; no clock needed (after-the-fact)

changes = merges.flatMap(m =>
  m.files.map(file => ({ agent: m.agent, file, at: m.at })))   // one per (agent,file)

total = changes.length
violations = []
warnings   = []
respected  = 0

for ({ agent, file, at } of changes):
  matching = claims.filter(c => c.globs.some(g => globsOverlap(file, g)))

  // held / active at the change time
  held(c) = at != null ? within(c, at) : notExpired(c)          // for coverage
  live(c) = at != null ? within(c, at) : c.status === "active"  // for violation

  covered   = matching.some(c => c.agent === agent && held(c))
  colliding = matching.filter(c => c.agent !== agent && live(c))

  if colliding.length:
    for c of colliding:
      violations.push({ agent, file, conflicting_claim: c })    // one per claim
    // a colliding change is never "respected", even if also covered
  else if covered:
    respected += 1
  else:
    warnings.push({ agent, file })

score = total === 0 ? 1 : respected / total
return { score, total, respected, violations, warnings }
```
Helpers:
- `within(c, at)` → `Date.parse(c.created) <= Date.parse(at) && Date.parse(at) < Date.parse(c.expires)`.
- `notExpired(c)` → `c.status !== "expired"` (status fallback for coverage when
  no `at`).
- Classification is a partition: a change with any colliding claim is a
  violation; otherwise respected if covered, else a warning. `respected` counts
  distinct changes; `violations` may hold several entries for one change (one per
  conflicting other-agent live claim).

### Reuse from #3 / #1
- `globsOverlap(file, glob)` from `src/glob.js` does all file-vs-glob matching.
  A concrete path has no `*`/`**`, so `globsOverlap` reduces to "does `file`
  match `glob`" — symmetric and already tested. No path-vs-glob matcher is added.
- ISO parsing: prefer reusing `isIso8601Utc` from `src/schema.js` (#1) to guard
  `at`/`created`/`expires` before `Date.parse`; if a timestamp is malformed the
  core treats it as "not held/active" (conservative) rather than throwing.

### CLI — `bin/worklease.js` `conformance` subcommand
- Positional args: `<registry>` (registry file path) then `<merges>` (merges file
  path). Flags: `--json`.
- **Load registry:** reuse the exact registry loader `check` uses — the interim
  JSONL reader (parse each non-empty line, keep the latest record per `id`,
  missing file = empty registry), swappable for #4's `loadRegistry` when it
  lands. Same code path as #3 so the two verbs never disagree on resolution.
- **Load merges:** read the file; if it parses as a JSON array, use it; otherwise
  treat it as JSONL (one merge record per non-empty line). Each record is
  `{ agent, files: string[], at? }`. A missing/empty merges file → `[]` (total 0).
- Call `conformance(claims, merges, {})`.
- **Print:** `--json` → the return object verbatim. Otherwise a readable summary:
  a headline (`coordination score 0.75 — 3/4 changes respected`), then one line
  per violation (`✗ <agent> edited <file> under <other-agent>'s claim —
  "<intent>" (active <created>–<expires>)`) and one per warning
  (`• <agent> edited <file> (unclaimed)`).
- **Exit:** `0` when `violations` is empty, else `1`. Warnings and a low score do
  **not** change the exit code (advisory). Missing registry/merges files are
  tolerated as empty inputs, not errors; a malformed JSON *array* or unparseable
  line prints a clear error and exits `1`. Unknown flag / missing positional →
  usage + exit `1`.

## Files / functions to touch
- **`src/conformance.js`** (new) — `conformance(claims, merges, opts)` + local
  helpers `within`, `notExpired`. Imports only `globsOverlap` from `./glob.js`
  (and optionally `isIso8601Utc` from `./schema.js`).
- **`src/index.js`** (edit) — also re-export `conformance` alongside
  `validateClaim`/`validateRegistry`/`globsOverlap`/`check`.
- **`bin/worklease.js`** (edit) — add the `conformance` subcommand and the merges
  reader; reuse the existing registry reader from the `check` verb; extend usage.
- **`test/conformance.test.js`** (new) — core classification + scoring.
- **`test/cli.test.js`** (edit) — `conformance` CLI cases against temp fixtures.
- **`README.md`** (update at implementation time, not in this spec PR) — a short
  `conformance` usage block and the merges-file shape.

No `package.json` changes: `main`, `bin`, `type: module`, `test: node --test`
are already correct.

## Test plan
Run with `npm test` (`node --test`).

**`conformance` core**
- Empty merges → `{ score: 1, total: 0, respected: 0, violations: [], warnings: [] }`.
- Empty registry, some changes → all warnings, `respected 0`, `score 0`, no
  violations.
- One change covered by the agent's own claim (glob matches, `at` inside
  `[created, expires)`) → respected, `score 1`, no lists.
- One change under a **different** agent's live claim → one violation
  `{ agent, file, conflicting_claim }` with the full claim; not respected.
- Change covered by own claim **and** colliding with another agent's live claim
  (double claim) → counted as a violation, not respected.
- Change on a file matched by **no** claim → a warning, not a violation.
- `at`-based windows: a change at `T` before a claim's `created`, or at/after its
  `expires`, is neither covered nor a violation by that claim (boundary:
  `T === expires` is *not* active; `T === created` *is*).
- Status fallback (no `at`): coverage uses a non-expired matching own claim;
  violation uses another agent's `status === "active"` claim; `released`/
  `expired` other-agent claims do not violate.
- A merge record with multiple `files` is flattened: `total` counts each file;
  mixed respected/violation/warning across the files scores correctly.
- One change under two different agents' live claims → two violation entries, the
  change counted once against `respected`.
- Score arithmetic: `respected / total` for a mixed set (e.g. 3 respected, 1
  violation, 1 warning over 5 → `respected 3`, `score 0.6`).
- Malformed `at`/`created`/`expires` → treated as not held/active (no throw).
- `globsOverlap` reuse: a claim glob `src/auth/**` covers touched
  `src/auth/login.ts`; `src/*.ts` does **not** cover `src/auth/login.ts`
  (inherits #3's semantics).

**CLI (`test/cli.test.js`)**
- Clean merges (all respected) → readable summary, exit `0`; `--json` parses to
  the object with empty `violations`.
- Merges with a violation → exit `1`; `--json` lists the violation with the full
  `conflicting_claim`.
- Merges with only warnings (low score, no collisions) → exit `0` (advisory).
- Merges file as a JSON array and as JSONL both load equivalently.
- Missing registry file → empty registry (all warnings), exit `0`.
- Missing merges file → total 0, `score 1`, exit `0`.
- Malformed merges JSON → clear error, exit `1`.
- Missing positional arg / unknown flag → usage, exit `1`.

## Risks / edge cases / migrations
- **Score semantics could surprise.** An unclaimed fleet scores `0` (all
  warnings) and a fleet with zero changes scores `1`. Both are intended (see
  PRODUCT.md); documented in the summary output and the README so a `0`/`1` isn't
  misread. This is the flagged open question — the score's numerator is a product
  decision the reviewer can overrule.
- **No release timestamp in the schema.** "Held/active at `T`" is a temporal
  window `[created, expires)`; a claim released *early* still counts as live
  inside that window because #1's schema records no release time. Noted as a
  precision limit; if it matters, #4's registry would add release timestamps and
  this core would consult them.
- **Malformed timestamps.** `at`/`created`/`expires` are guarded with the ISO
  regex before `Date.parse`; an invalid value makes that claim "not held/active"
  (conservative — never invents coverage or a violation) rather than throwing.
- **Conservative overlap inherited from #3.** File-vs-glob uses satisfiability
  (dotfiles included, no FS), so coverage/violation may be reported for a glob
  that, in a real tree, wouldn't match — the safe direction for an audit.
- **Registry coupling to #4.** The core takes a resolved claim array and is fully
  testable now; only the CLI's registry reader depends on #4. It reuses #3's
  interim reader, so shipping before #4 doesn't block and adopting #4's loader is
  a localized change.
- **Merges input trust.** `conformance` trusts the supplied merges as ground
  truth for "who touched what"; producing that data from git is a separate
  adapter concern (v0.2), out of scope here.
- **No migrations.** Greenfield module; no persisted data or schema changes.

## Alternatives considered
- **Score = no-collision rate only (ignore coverage)** — rejected: an entirely
  unclaimed fleet would score `1.0`, the opposite of "did the fleet coordinate?"
  Coverage belongs in the numerator; flagged for the human gate.
- **Treat unclaimed-file edits as violations** — rejected: an unclaimed edit
  collides with no live claim, and "hotspot" isn't knowable without extra config;
  it is a warning that lowers the score, not a hard failure.
- **A new path-vs-glob matcher** — rejected: a concrete file is a wildcard-free
  glob, so `globsOverlap` already answers it; reusing #3 keeps one tested core
  and guarantees `check` and `conformance` agree on matching.
- **Filesystem/git-aware conformance (diff the merges itself)** — rejected: the
  core stays pure and deterministic over supplied data; git integration is a
  separate adapter (v0.2), not part of the metric.
- **Fold `conformance` into `check`** — rejected: `check` is a pre-edit
  point-query; `conformance` is an after-the-fact batch audit with a distinct
  return shape. Separate modules keep each small and composable.
- **Require `at` on every merge record** — rejected: a status-based fallback lets
  a simple merges list (no timestamps) still be scored, while `at` unlocks
  TTL-accurate scoring; recommended but not mandatory.
