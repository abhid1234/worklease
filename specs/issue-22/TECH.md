# Technical spec — Issue #22: validate records on the `resolveRecords` read path

## Approach
Add two read-path validators to `src/schema.js` — `validateClaimRecord(r)` and
`validateReleaseRecord(r)` — each returning the module's existing
`{ valid, errors }` shape, and call them inside `resolveRecords`
(`src/registry.js`) during the fold step, *after* the integrity filter and
*before* any release is applied or any expiry is derived. A record that passes
integrity but fails its type's validator is skipped with a single note, exactly
as the existing integrity/parse skips work. No consumer changes are needed: once
`resolveRecords` only emits well-formed claims, `check`, `conformance`, and
`list` are safe by construction — the fix is centralized on the one read path
they all share.

The read-path validators are deliberately **separate** from the public
`validateClaim`. `validateClaim` answers "is this a well-formed claim to *file*?"
and is strict (rejects unknown fields, requires `status`, cross-checks
`expires === created + ttl`). `validateClaimRecord` answers "is this stored
record safe to *fold and consume*?" — it enforces the fields the consumers
dereference, tolerates a forward-compat `type: "claim"` (and other unknown
fields, per the vision's forward-compat stance), and does **not** re-run the
`EXPIRES_MISMATCH` cross-check (the id integrity hash already pins the record's
content; re-deriving the lease on read adds nothing).

## Files / functions to touch

### `src/schema.js` — new read-path validators (reusing existing helpers)
The per-field checks already exist in this file (`checkStringField`,
`isIso8601Utc`, `isAllowedGlob`, `STATUSES`, the `globs` array check). Factor the
shared field checks so both the public and read-path validators use them, or call
the existing helpers directly — either way, **no new field logic**.

```
// A stored claim record is safe to fold/consume iff every field the consumers
// dereference is well-shaped. Tolerant of an optional `type: "claim"` and of
// extra forward-compat fields (no UNKNOWN_FIELD); no expires/created/ttl
// cross-field check (that is a claim-time concern).
validateClaimRecord(r) -> { valid, errors }
  // r must be a plain object (non-objects are already dropped upstream).
  // if "type" in r: must === "claim"           (WRONG_TYPE otherwise)
  // agent   — required, non-empty string
  // globs   — required, non-empty array; every entry an allowed glob string
  //           (this is THE crash vector: check/conformance/list deref it)
  // intent  — required, non-empty string
  // ttl_seconds — required, integer > 0
  // created — required, ISO-8601-UTC
  // expires — required, ISO-8601-UTC
  // status  — required, one of STATUSES
  // id      — present & non-empty (already guaranteed by the integrity filter;
  //           checked for completeness so the validator stands alone)

// A release record is safe to apply iff it can address and attribute a release.
validateReleaseRecord(r) -> { valid, errors }
  // type    — must === "release"
  // claim_id — required, non-empty string (used as the claims Map key)
  // agent   — required, non-empty string (recorded as released_by; ownership note)
  // at      — required, ISO-8601-UTC   (recorded as released_at; shown by list)
```

Export both, plus (optionally) a `RELEASE_FIELDS` constant mirroring
`CLAIM_FIELDS`, for symmetry and reuse in tests.

### `src/registry.js` — enforce in `resolveRecords`
Fold step (currently lines ~119–133): after determining `type`, validate before
accepting the record.

```
for (const r of valid) {
  const type = r.type == null ? "claim" : r.type;
  if (type === "claim") {
    const { valid: ok, errors } = validateClaimRecord(r);
    if (!ok) { notes.push(`skipped record ${shortId(r.id)}: invalid claim (${fields(errors)})`); continue; }
    claims.set(r.id, { ...r });
  } else if (type === "release") {
    const { valid: ok, errors } = validateReleaseRecord(r);
    if (!ok) { notes.push(`skipped record ${shortId(r.id)}: invalid release (${fields(errors)})`); continue; }
    releases.push(r);
  } else {
    notes.push(`skipped record ${shortId(r.id)}: unknown type "${r.type}"`);
  }
}
```

- `fields(errors)` = a short, deduped, comma-joined list of the offending field
  paths (e.g. `globs, agent`) — **no raw values**, honoring the "no secrets in
  notes" guardrail.
- Import `validateClaimRecord` / `validateReleaseRecord` from `./schema.js`.
  (`registry.js` currently imports nothing from `schema.js`; `conformance.js`
  already imports `isIso8601Utc` from it, so the dependency direction is fine and
  introduces no cycle — `schema.js` imports nothing from `registry.js`.)
- Update the `resolveRecords` docstring (step 2) to state that records are now
  schema-validated per type and invalid ones are skipped with a note, so the
  "no bad field value throws" promise now extends to the consumers.

No other files change. `check.js`, `conformance.js`, and `bin/worklease.js`
consumers are left as-is — they become safe once the read path is clean.

## Test plan
This repo uses `npm test` (`node --test`). Add cases to
`test/registry.test.js` (fold behavior) and `test/schema.test.js` (the new
validators); an integration assertion belongs in `test/check.test.js` /
`test/conformance.test.js`.

- **schema.test.js**
  - `validateClaimRecord`: accepts a real `makeClaim(...)` record; accepts the
    same record with an added `type: "claim"`; rejects missing `globs`,
    non-array `globs`, `globs: []`, a non-string glob, missing `agent`/`intent`,
    non-integer/≤0 `ttl_seconds`, bad `created`/`expires`, bad `status`; the
    `errors` array names the offending paths.
  - `validateReleaseRecord`: accepts a real release record
    (`{ type, claim_id, agent, at }`); rejects missing `claim_id`, missing
    `agent`, missing/malformed `at`, wrong `type`.
- **registry.test.js**
  - A JSONL registry where one line is a content-hash-valid claim with
    non-array `globs`: `resolveRecords`/`loadRegistry` excludes it and adds a
    note; the other (valid) claims still resolve.
  - A content-hash-valid `release` missing `claim_id`/`agent`/`at` is not
    applied — the target claim stays `active` — and a note is emitted.
  - Mixed registry (valid claim + invalid claim + valid release + invalid
    release + unknown-type record): only the valid claim/release survive; notes
    count matches the number of skips.
  - Round-trip: a registry written entirely by `makeClaim` + the `release` path
    resolves with **zero** validation notes (no regression on healthy data).
  - Identical results under `{ expire: true }` and `{ expire: false }`.
- **check.test.js / conformance.test.js**
  - Feed a registry containing the malformed-`globs` line through
    `loadRegistry` → `check(...)` and `→ conformance(...)`: neither throws, and
    results reflect only the valid claims. (These would `TypeError` today.)

## Risks / edge cases / migrations
- **No data migration.** The registry file format is unchanged; this only changes
  how the read path *interprets* already-written lines. Old registries load fine.
- **Over-strictness risk (the main one).** If `validateClaimRecord` is stricter
  than what `makeClaim` actually writes, legitimate claims would be silently
  dropped, weakening coordination. Mitigation: the round-trip test above asserts
  every `makeClaim`/`release`-produced record validates; keep the read-path
  contract to the fields consumers touch and stay forward-compat lenient.
- **Forward compatibility.** Extra/unknown top-level fields on a claim record are
  tolerated (unlike `validateClaim`), so a future field addition doesn't cause
  old readers to drop new claims. Unknown record *types* keep their existing
  skip-with-note.
- **Note volume.** A badly corrupted registry could emit many notes; that is the
  intended, honest signal (and matches how unparseable lines already note). Notes
  stay one-per-record and value-free.
- **Ordering invariant.** Validation must run in the fold loop (before releases
  are applied and before expiry derivation) so an invalid release can never flip
  a claim and an invalid claim never reaches expiry logic. The snippet above
  preserves this.
- **Performance.** One O(fields) validation per record on each read; registries
  are small and reads are already O(n) — negligible, zero-dep.

## Alternatives considered
- **Reuse `validateClaim` as-is on the read path** — rejected: it rejects the
  `type: "claim"` discriminator and any forward-compat field as `UNKNOWN_FIELD`,
  requires the `EXPIRES_MISMATCH` cross-check, and would drop legitimate stored
  records; claim-time strictness is the wrong contract for reading back.
- **Guard each consumer (`claim.globs && Array.isArray(...)` in check/
  conformance/list)** — rejected: scatters the fix across every current and
  future consumer, is easy to forget (the `list` path was already a third
  crasher), and leaves the `resolveRecords` "never emits a landmine" contract
  gap unfixed. Centralizing on the read path fixes it once.
- **Hard-fail the whole load on any invalid record** — rejected: violates the
  module's "one bad line never discards the rest" invariant and roadmap
  principle #2 — a single corrupt append would disable every check, which is the
  exact failure mode this issue exists to prevent.
- **Enforce only `globs` (minimal crash-only fix)** — viable and listed as the
  Open Question; rejected as the default because a malformed `expires`/`status`
  produces a *silent* coordination hole (the claim loads but never protects),
  which is harder to notice than a visible skip-with-note.
