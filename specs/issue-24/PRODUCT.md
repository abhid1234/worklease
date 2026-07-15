# Product spec — Issue #24: what a `released` claim means for coverage (status fallback)

## Problem / motivation
`conformance` scores every `(agent, file)` change against the registry. When a
merge record carries **no `at` timestamp**, the core can't do a temporal
comparison, so it falls back to the claim's `status`. Today the coverage
predicate is `notExpired(c) = c.status !== "expired"`, which counts a
**`released`** claim as coverage for the acting agent — while the collision
predicate counts only `status === "active"`. Codex flagged that asymmetry: "a
released claim is no longer held, so an uncovered edit can incorrectly be counted
as respected."

Triage confirmed the asymmetry is real but concluded the fix hides a genuine
**product decision**, not a clean one-liner: without timestamps there is no way
to tell "I claimed → edited → *properly released* when done" (the happy path
every well-behaved agent follows) from "I released, then edited *after*"
(uncovered). Making coverage strictly `active`-only would flag the entire happy
path (claim → edit → release → audit) as `warning`s. So *what `released` means
for coverage in a status-only audit* has to be decided deliberately — and
decided **together with #23**, which fixes the timestamped (`at`-present) path.

## Direction (recommended)
**In the status fallback, a `released` claim continues to count as coverage; the
`held` (lenient: `active` **or** `released`) vs. `live` (strict: `active` only)
asymmetry is intentional and will be made explicit — not "fixed away."**

Rationale, grounded in vision + roadmap:
- **Coverage credits *declared intent*; collision fires only on *live* work.**
  A `released` claim is proof the agent *did* coordinate — it declared the glob,
  did the work, and released cleanly. Crediting that as coverage is correct. A
  `released` claim is *not* a live lease, so another agent editing over it is not
  a collision. The two predicates answer different questions, so they are
  *supposed* to differ.
- **The happy path must score as respected.** Roadmap §5 and the release verb
  assume well-behaved agents release when done. A coordination score that marks a
  claim → edit → release fleet as uncovered `warning`s would punish exactly the
  behavior worklease asks for, making the metric misleading and un-adoptable.
  That over-warning cuts against the "advisory, fair" principle (roadmap §1).
- **The one case leniency mis-scores — an edit *after* release — is precisely
  what timestamps catch.** With `at` + `released_at` present, #23 makes coverage
  end at `released_at`, so a post-release edit is correctly uncovered. The
  status-only fallback fundamentally *cannot* locate a change in time, so it
  cannot make that distinction; the honest response is to assume the common case
  (proper release) and tell users to supply `at` for precision.
- **The current test suite already encodes this as a deliberate choice**
  (`test/conformance.test.js:104-115` asserts `released` own claim → respected,
  `released` other-agent claim → 0 violations). This issue ratifies and
  *documents* that decision so a future reader doesn't "fix" it back into a
  happy-path regression.

Rejected alternative — **strict symmetric** (coverage requires `active`,
matching `live`): cleaner as a within-path invariant and is Codex's literal
suggestion, but it flags the entire happy path as warnings and would force
rewriting the existing tests to punish released-when-done fleets. Rejected as the
default; surfaced as the open question below because the roadmap reserves this
call for the human gate.

## Desired behavior
For a change with **no `at`** (status fallback), holding registry claim `c`:

| `c.status`  | acting agent's own claim → **coverage?** | other agent's claim → **collision?** |
|-------------|------------------------------------------|--------------------------------------|
| `active`    | yes (covered)                            | yes (violation)                      |
| `released`  | **yes (covered)** — declared+completed   | **no** — not a live lease            |
| `expired`   | no (uncovered → warning)                 | no                                   |

This preserves today's runtime outcomes; the change is legibility, documentation,
and locked-in tests — plus consistency with #23 on the timestamped path.

Consistency with #23 (the two paths, decided together):
- **`at` present (temporal, #23):** coverage/collision hold only while
  `created ≤ at < expires` **and** `at < released_at` — a change after release is
  neither covered nor a collision. Precise.
- **`at` absent (status fallback, #24):** no time to compare, so `released` =
  covered (happy-path assumption) and `released` ≠ live collision. Best-effort;
  supplying `at` upgrades to the precise path above.

Neither path treats a `released` claim as a live collision, and both credit a
properly-held-then-released claim as coverage for in-window work — they differ
only in whether they can detect the post-release edit (only the timestamped path
can). That is the intended, documented relationship.

## Acceptance criteria
- [ ] The status-fallback coverage predicate is expressed explicitly as
      "`active` **or** `released`" (not the incidental `!== "expired"`), with a
      comment stating that `released` = declared-and-completed intent = coverage,
      and that the `held`/`live` asymmetry is intentional.
- [ ] The collision (`live`) predicate is unchanged: status fallback still fires
      only on `status === "active"`.
- [ ] The `expired` status remains uncovered (a warning) in the status fallback.
- [ ] The module doc / predicate comments state that precise post-release
      detection requires timestamps (`at` + `released_at`, handled by #23), and
      that the status fallback cannot distinguish a proper release from a
      post-release edit.
- [ ] Tests pin the decided semantics for the no-`at` path: `released` own claim
      → respected; `released` other-agent claim editing over the file → warning
      (not a violation); `expired` own claim → warning. Existing assertions at
      `test/conformance.test.js:104-115` continue to pass.
- [ ] `npm test` is green. No behavior change to the timestamped path (that is
      #23), no CLI change, no schema change.

## Non-goals
- **The timestamped (`at`-present) path** — folding `released_at` into `within`
  is issue #23; #24 touches only the status fallback and the docs/tests. No code
  overlap (#23 edits `within`; #24 edits the status helper).
- Changing collision semantics, adding new claim statuses, or reading
  `released_at` in the status path (there is no change time to compare it to).
- Any CLI, output-shape, or `score` formula change.

## Open questions
- **Ratify lenient vs. strict.** Recommended: **lenient** — `released` counts as
  coverage in the status fallback (documented here; already how the code and
  tests behave). The roadmap reserves this semantics call for the human gate, so
  confirm before implementing. If the reviewer prefers **strict symmetric**
  (`active`-only coverage, per Codex's literal suggestion), the implementation
  flips the predicate to `status === "active"` and updates
  `test/conformance.test.js:104-115` to assert `released` own claim → warning —
  accepting that well-behaved release-when-done fleets then score below 1.0.
