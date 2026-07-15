# Technical spec — Issue #24: status-fallback coverage semantics for `released`

## Approach
Ratify the intended semantics of the status fallback and make them legible, with
no runtime behavior change on the recommended (lenient) direction. Replace the
incidental `notExpired(c) = c.status !== "expired"` coverage helper with an
explicit predicate that names the decision — a `released` claim is
declared-and-completed intent, so it *covers* the acting agent's change, while it
is *not* a live lease, so it never counts as a collision. Document the
`held`/`live` asymmetry and the fact that the status-only path cannot distinguish
a proper release from a post-release edit (that precision is the timestamped
path, issue #23). Lock the decision with tests so the plausible-looking "strict"
fix can't silently regress the happy path. This is a docs-, naming-, and
test-level change to one pure module; zero new dependencies.

## Files / functions to touch
- **`src/conformance.js`**
  - Rename `notExpired` → `coveredByStatus` and define it explicitly:
    ```js
    // Status fallback for COVERAGE when a change has no `at`. A `released` claim
    // is declared-and-completed intent, so it still covers the acting agent's
    // change; only `expired` is uncovered. Asymmetric with the collision
    // predicate below (`status === "active"` only) by design: coverage credits
    // declared intent, a collision fires only on a *live* lease. Without an `at`
    // we can't tell a proper release from a post-release edit — supply `at` for
    // the precise, `released_at`-aware path (issue #23).
    function coveredByStatus(c) {
      return c.status === "active" || c.status === "released";
    }
    ```
  - Update the call site (`src/conformance.js:62`):
    `const held = (c) => (at != null ? within(c, at) : coveredByStatus(c));`
  - Leave `live` unchanged (`src/conformance.js:63`): status fallback stays
    `c.status === "active"`.
  - Extend the module docstring / the `held`/`live` comments to state the decided
    semantics: coverage = `active | released`, collision = `active` only, and
    that precise post-release detection needs `at` + `released_at` (#23).
- **`test/conformance.test.js`** — keep the existing status-fallback assertions
  (lines 104-115); add a short comment tagging them to issue #24, and add the
  explicit other-agent-editing-over-a-released-claim → **warning** case (see
  Test plan). No product code beyond `src/conformance.js`.

Do **not** touch `within` or `released_at` handling — that is issue #23.

## Test plan (`npm test`)
Node's built-in `node:test`, matching the existing suite. Status-fallback cases
(no `at`):
- **`released` own claim → respected** (already asserted, `:107`) — keep.
- **`released` other-agent claim, agent edits the file → warning, 0 violations.**
  New/explicit: assert the change lands in `warnings` (not `violations`) and does
  not count as respected — a released lease is not a live collision.
- **`expired` own claim → warning** (already asserted, `:108`) — keep.
- **`active` own claim → respected**, **`active` other-agent → violation**
  (already asserted, `:106`, `:113`) — keep as the contrast rows.
- Regression guard: the timestamped path is unchanged — existing `within`-based
  tests (INSIDE/BEFORE/AFTER) still pass untouched.

All existing tests must stay green; the rename is internal (only call site is
`src/conformance.js:62`, confirmed by grep — no other importers).

## Risks / edge cases / migrations
- **No migration, no data change, no output-shape change.** Pure-function rename
  + docs + tests; the recommended direction is behavior-preserving.
- **Interaction with #23:** disjoint code (#23 edits `within`; #24 edits the
  status helper). If #23 lands first, this still applies cleanly; if #24 lands
  first, #23's temporal fix is unaffected. They must be *decided* together
  (this spec + #23's spec) so the released-vs-coverage story is consistent across
  both paths, but they do not edit the same lines.
- **Status values beyond the schema:** `STATUSES = ["active","released","expired"]`
  (`src/schema.js:14`). The explicit `active || released` is equivalent to
  `!== "expired"` today but is robust if a new status is ever added — it won't
  silently grant coverage to an unknown status.
- **If the reviewer chooses strict** (open question): change the helper body to
  `c.status === "active"` and flip `test/conformance.test.js:107` to assert the
  `released` own claim → warning; note the happy path then scores < 1.0.

## Alternatives considered
- **Strict symmetric coverage (`active`-only), per Codex's suggestion** — makes
  `held` == `live` in the status path; rejected as default because it flags the
  entire claim → edit → release happy path as warnings and mis-scores
  well-behaved fleets. Kept as the open question for the human gate.
- **Read `released_at` in the status fallback** — impossible/meaningless: with no
  change-time `at`, there is nothing to compare `released_at` against. That
  distinction belongs to the timestamped path (#23).
- **Leave `notExpired` as-is** — rejected: the incidental `!== "expired"` reads
  like an oversight (which is why Codex flagged it), inviting a future regression;
  naming the decision and pinning it with tests is the durable fix.
