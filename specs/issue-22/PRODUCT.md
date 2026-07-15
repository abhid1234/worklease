# Product spec — Issue #22: `resolveRecords` must validate records before folding them

## Problem / motivation
`resolveRecords` (`src/registry.js`) folds the append log into the current claim
array after only an **integrity** check — it verifies each record's `id` equals
its own content hash, then treats any typeless (or `type: "claim"`) record as a
claim without checking that the claim is *shaped* like a claim. Its docstring
promises "no bad field value throws," but that guarantee holds only inside
`resolveRecords`; the consumers dereference fields it never validated. A single
registry line with a correctly-computed `id` but a missing or non-array `globs`
— a hand-edited registry, a buggy writer, or a hostile append — passes the
integrity filter, folds into the claim set, and then throws `TypeError` in the
consumers: `src/check.js:30` (`claim.globs.filter(...)`), `src/conformance.js:60`
(`c.globs.some(...)`), and `bin/worklease.js:339` (`c.globs.join(...)` in `list`).
One corrupt line therefore disables the very checks worklease exists to provide —
a direct violation of roadmap principle #2 ("the registry never conflicts with
itself") and of the advisory-safety posture.

## Desired behavior
`resolveRecords` (and, through it, `loadRegistry`) validates each
integrity-passing record against the shape its consumers rely on, **skips**
records that don't conform, records a concise **note** explaining the skip, and
returns only safe, well-formed claims. One malformed record never crashes a
consumer and never discards the rest of the registry — exactly the tolerance the
module already applies to non-objects, id/content mismatches, and unparseable
lines.

Concretely, after this change:

- A claim record missing `globs`, or whose `globs` is not a non-empty array of
  strings, is dropped with a note like `skipped record <shortId>: invalid claim
  (globs)`; the remaining claims resolve normally.
- The same holds for a claim record missing/malformed in the other fields the
  consumers depend on (`agent`, `intent`, `status`, `created`, `expires`,
  `ttl_seconds`) — see TECH.md for the exact enforced contract.
- A `release` record missing `claim_id`, `agent`, or a valid `at` is dropped
  with a note and is **not** applied to any claim (so a malformed release can't
  silently flip a live claim to `released`).
- Every dropped record produces exactly one note; notes carry no secrets and no
  raw record dumps — a short id and the offending field name(s) only.
- `check`, `conformance`, and `list` **never throw** on a registry containing
  arbitrary corrupt lines, however many.
- All records written by the current `makeClaim` / `release` code paths continue
  to validate and fold exactly as they do today (no behavior change on healthy
  registries).

## Acceptance criteria
- [ ] `resolveRecords` validates each integrity-passing record before folding it;
      invalid claim records are excluded from the returned `claims` array.
- [ ] Invalid `release` records are not applied (no state change to any claim).
- [ ] Every skipped record adds exactly one human-readable note; notes contain no
      raw field values beyond the short id and the field name(s) at fault.
- [ ] A registry line with a valid content-hash `id` but missing/non-array
      `globs` no longer crashes `check`, `conformance`, or `list` — it is skipped
      with a note, and the other claims still resolve.
- [ ] Well-formed claim records produced by `makeClaim` and well-formed release
      records produced by the `release` path pass validation unchanged (a
      round-trip test asserts this so healthy registries keep working).
- [ ] The behavior is identical under `expire: true` and `expire: false` (the
      `conformance` read path), since validation runs before expiry derivation.
- [ ] `npm test` passes, including new cases covering the malformed-claim,
      malformed-release, mixed-valid-and-invalid, and round-trip scenarios.
- [ ] Zero new runtime dependencies; the validators live in `src/schema.js`
      alongside the existing ones and follow the same `{ valid, errors }` shape.

## Non-goals
- Not repairing or rewriting corrupt records — invalid lines are skipped, never
  edited (the store stays append-only; nothing is written back).
- Not changing the public claim-time validator `validateClaim` or its strict
  contract (rejects unknown fields, requires `status`, cross-checks
  `expires === created + ttl`) — that governs *filing* a claim, a different and
  stricter concern than reading one back.
- Not adding hard-fail / abort-the-load behavior — a single bad line must never
  prevent the rest of the registry from resolving.
- Not adding a `type` field to written claim records — typeless remains the
  canonical claim; the read path merely *tolerates* an explicit `type: "claim"`.
- Not introducing new record types beyond the existing `claim` / `release`
  discriminator (unknown types keep their current forward-compat skip-with-note).

## Open questions
- **Strictness of the claim read-path contract.** This spec recommends enforcing
  the full structural contract the consumers touch (`globs`, `agent`, `intent`,
  `status`, `created`, `expires`, `ttl_seconds`), so a claim that would silently
  fail to protect (e.g. an unparseable `expires` that `check` treats as expired)
  is surfaced as a skip-with-note rather than a silent coordination hole. The
  narrower alternative is to enforce only the crash vector (`globs`) and leave
  the rest lenient. Recommendation: the fuller structural contract, because a
  claim that can't be relied on is worse than a claim that's visibly dropped. A
  human should confirm this before implementation.
