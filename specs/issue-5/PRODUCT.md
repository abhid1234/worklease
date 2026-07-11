# Product spec — Issue #5: `worklease conformance` (did the fleet coordinate?)

## Problem / motivation
`claim`/`check`/`release` help a fleet coordinate *before* the edit. But a fleet
can ignore worklease entirely, or an agent can edit outside what it claimed —
and nobody would know. `conformance` closes the loop *after the fact*: given the
registry and the actual merged changes (which files each agent touched), it
scores whether coordination really happened. It answers two questions per
change — *did the acting agent hold a claim covering the file it touched?* and
*did it edit a file under another agent's live claim?* — and returns a single
coordination score plus the list of collisions. This is the metric the vision
promises ("score after the fact whether a set of merges respected the claims")
and the honest measure of whether the whole format is being used.

## Desired behavior
`worklease conformance <registry> <merges>` reads the registry file and a
**merges** file (the files each agent actually touched) and reports how well the
merges respected the claims.

Output shape (also the return value of the library core):
```json
{
  "score": 0.75,
  "total": 4,
  "respected": 3,
  "violations": [
    { "agent": "codex-2",
      "file": "src/auth/login.ts",
      "conflicting_claim": { /* the full claim record another agent held */ } }
  ],
  "warnings": [
    { "agent": "codex-2", "file": "docs/README.md" }
  ]
}
```

### Inputs
- **`<registry>`** — the worklease registry file (append-only JSONL, resolved to
  the current claim array), exactly as `check` consumes it (#3/#4). Each claim is
  `{ id, agent, globs[], intent, ttl_seconds, created, expires, status }` (#1).
- **`<merges>`** — a JSON array (or JSONL) of merge records, each
  `{ agent, files: ["path", …], at? }`:
  - `agent` — who made the change (matched against claim `agent`, exact string).
  - `files` — the concrete file paths that agent touched in the merge.
  - `at` (optional) — ISO-8601-UTC timestamp of when the change landed. Used to
    decide which claims were **held / active at the time**. Recommended; see the
    fallback below when absent.

### What counts, per change
A **change** is one `(agent, file)` pair (merge records are flattened over
`files`). For each change by agent `A` on file `F` at time `T`:

- **Covered** — `A` held a claim whose globs match `F`, held at time `T`
  (`created ≤ T < expires`). "Held" is temporal: a claim `A` filed and later
  released still counts as held during its window.
- **Violation** — a **different** agent `B` held a claim whose globs match `F`
  that was **active at time `T`** (`created ≤ T < expires`). `A` edited a file
  under `B`'s live lease — the collision worklease exists to prevent. One
  violation entry per conflicting other-agent claim.
- **Respected** — the change is *covered by `A`'s own claim* **and** is *not a
  violation*. These are the fully-coordinated changes and the numerator of the
  score.
- **Warning** — the change is **uncovered** (`A` held no matching claim) **and**
  is **not** a violation (nobody else held a live claim on `F` either). This is
  the "edited an unclaimed file" case — a tolerated warning, not a collision.

Each change is exactly one of {respected, violation, warning}: any change that
collides with another agent's active claim is a violation (even if `A` also held
a claim on it — a double-claim); otherwise it is respected if covered, else a
warning.

### Score
- `total` — number of `(agent, file)` changes evaluated.
- `respected` — number of changes that are respected (covered ∧ non-colliding).
- `score` — `respected / total`, a float in `[0, 1]` (`1` when `total === 0`).
  The coordination score: the fraction of changes that both stayed inside a
  claim the agent held *and* avoided another agent's live lease.
- `violations` — every collision, richest signal for a human/harness to act on.
- `warnings` — uncovered, non-colliding changes (coordination simply didn't
  happen there); they lower the score but are not failures.

### Locked product decisions
The issue flags one open question ("what counts as a violation vs a tolerated
warning, e.g. editing an unclaimed hotspot file"); this spec resolves it and two
adjacent decisions:

1. **Violation = editing under another agent's *active* claim — nothing else.**
   Editing an **unclaimed** file (no other agent's live claim) is a **warning**,
   not a violation: it lowers the score but is not listed in `violations` and
   does not flip the exit code. Rationale: a violation is a real *collision* with
   a live reservation — the thing worklease prevents. "Hotspot" is not knowable
   without extra config, and an unclaimed edit collides with no one.
2. **The score rewards coverage, not just absence of collisions.** A change is
   only "respected" if the agent actually held a claim for it. So a fleet that
   never claims anything scores **0** (all warnings), not 1 — correctly reading
   as "no coordination happened," matching the roadmap framing (*did each change
   fall within a claim the merger held, **and** did anyone violate an active
   claim?*). Absence of violations alone is not coordination.
3. **"Held / active at the time" is temporal when a timestamp is available.**
   With `at`, a claim is held/active at `T` iff `created ≤ T < expires`
   (TTL-accurate; a since-released or since-expired claim still counted while its
   window contained `T`). Without `at`, fall back to claim `status`: coverage =
   `A` has a matching claim of any non-expired status; violation = another
   agent's matching claim with `status === "active"`. Precise scoring wants `at`.

## Acceptance criteria
- [ ] A pure, exported `conformance(claims, merges, opts)` returns
      `{ score, total, respected, violations, warnings }` exactly as specified,
      with zero runtime dependencies and no filesystem access.
- [ ] File-vs-glob matching reuses `globsOverlap` from #3 (a concrete file path
      is a wildcard-free glob); no new glob logic is introduced.
- [ ] `total` counts every `(agent, file)` change (merge records flattened over
      `files`); `respected` counts distinct changes that are covered by the
      acting agent's own held claim and collide with no other agent's active
      claim; `score = respected / total`, and `score === 1` when `total === 0`.
- [ ] A change that edits a file under a **different** agent's claim active at
      the change time produces a `violations` entry
      `{ agent, file, conflicting_claim }` — one per conflicting claim — with the
      full claim record; such a change is **not** counted as respected.
- [ ] A change the acting agent did **not** cover, and that collides with no
      other agent's active claim, produces a `warnings` entry `{ agent, file }`
      and is not a violation.
- [ ] A change covered by the agent's own held claim with no collision is
      respected and appears in neither list.
- [ ] "Held / active at the time" uses `created ≤ at < expires` when a merge
      record has `at`; otherwise it falls back to claim `status`.
- [ ] An empty merges set → `{ score: 1, total: 0, respected: 0, violations: [],
      warnings: [] }`. An empty/absent registry → every change is a warning,
      `score === 0` (unless `total === 0`), and no violations.
- [ ] `worklease conformance <registry> <merges>` loads both files, prints a
      readable summary (score, N respected / M total, each violation and
      warning), supports `--json` emitting the return value verbatim, and exits
      `0` when there are **no violations**, `1` when any violation is found.
      Exit code keys on violations only — a low score from warnings does not fail
      (advisory, not a lock).
- [ ] `npm test` passes with unit tests for the core and the CLI.

## Non-goals
- **Not** filesystem- or git-aware: `conformance` does not run `git`, diff, or
  read the working tree. The caller supplies the merges (the files each agent
  touched); the core is pure over that data. (A git adapter that *produces* a
  merges file is a later, separate concern — v0.2 adapters, roadmap #6/#7.)
- **Not** the registry engine (append-only JSONL / hash-chaining / TTL) — that
  is #4; `conformance` consumes a resolved claim array, and the CLI reuses the
  same registry loader as `check`.
- **Not** claim validation — assumes a well-formed registry (may reuse #1's
  validator at load time).
- **Not** enforcement: the score and violations are advisory. The non-zero exit
  is a hint a CI/merge gate *may* act on, not a lock.
- **Not** extending glob syntax beyond #1's subset, and **not** re-deriving glob
  overlap — it reuses `globsOverlap` (#3).
- **Not** detecting "hotspot" files, missing claims policy, or per-team rules —
  the metric is claim-relative only.

## Open questions (for the human gate)
Written around the recommended answers above; a reviewer may overrule:
- **Score definition — coverage-and-no-collision (chosen) vs. no-collision
  only.** Chosen so an unclaimed fleet scores 0 (no coordination) rather than 1.
  The reviewer may prefer the respect-only reading if the score should measure
  *only* "did merges violate live claims," treating coverage purely as warnings.
- **Unclaimed-file edit = warning, not violation (the issue's open question).**
  Chosen: warning (lowers score, not in `violations`, does not fail exit). If a
  reviewer wants uncoordinated edits to hard-fail, they can escalate warnings to
  violations — but that would flag every non-participating agent as a violator.
- **Temporal window vs. final status for "held."** Chosen: temporal when `at` is
  present. Note the #1 schema has no explicit release timestamp, so a claim
  released *before* a change inside its `[created, expires)` window is still
  counted as held/active at that time. If release-time precision matters, #4's
  registry would need to record release timestamps.
