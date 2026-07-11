# Product spec — Issue #1: the claim + registry schema and validator

## Problem / motivation
worklease is the open coordination format for fleets of parallel AI coding
agents. Everything the project ships — `claim`, `check`, `release`,
`conformance`, the registry, the playground — consumes one shared shape: a
**claim** (an agent's declared intent to edit a set of file globs for a TTL).
Before any verb can exist, that shape has to be defined once, precisely, and
enforced. This issue is that foundation: the open JSON schema for a claim and a
zero-dependency validator that every downstream feature (and every third-party
harness) can trust.

## Desired behavior
A claim is a JSON object with exactly these fields:

| field | type | meaning |
|---|---|---|
| `id` | string (non-empty) | stable content-hash identifier for the claim |
| `agent` | string (non-empty) | who filed the claim (agent/worker identifier) |
| `globs` | array of ≥1 non-empty strings | the file globs the agent intends to touch |
| `intent` | string (non-empty) | *why* — human-readable purpose ("add OAuth") |
| `ttl_seconds` | integer > 0 | lease duration in seconds |
| `created` | string, ISO 8601 UTC (`…Z`) | when the claim was filed |
| `expires` | string, ISO 8601 UTC (`…Z`) | when the lease ends |
| `status` | `"active"` \| `"released"` \| `"expired"` | lifecycle state |

A **registry** is a JSON array of claim records (the resolved current state of
the fleet's claims).

The library exposes two pure, zero-dependency functions plus a CLI verb:

- `validateClaim(obj)` → `{ valid: boolean, errors: Error[] }`
- `validateRegistry(arr)` → `{ valid: boolean, errors: Error[] }`
- `worklease validate <file>` → validates a claim or registry file, prints
  human-readable errors, exits `0` (valid) or `1` (invalid).

Each structured error is `{ path, code, message }`:
- `path` — dot/bracket path to the offending value (`"globs[0]"`,
  `"[2].ttl_seconds"`, or `""` for the whole object).
- `code` — stable machine-readable code (e.g. `MISSING_FIELD`, `WRONG_TYPE`,
  `INVALID_ENUM`, `EMPTY_STRING`, `EMPTY_ARRAY`, `NOT_POSITIVE_INT`,
  `INVALID_ISO8601`, `EXPIRES_MISMATCH`, `INVALID_GLOB`, `UNKNOWN_FIELD`,
  `DUPLICATE_ID`, `NOT_OBJECT`, `NOT_ARRAY`).
- `message` — one-line human explanation.

A valid object returns `{ valid: true, errors: [] }`. An invalid object returns
`{ valid: false, errors: [...] }` with **all** violations reported (not just the
first), so a harness or a human can fix everything in one pass.

## Locked product decisions
The issue and triage flagged five decisions. Recommended answers, taken here:

1. **Is `intent` required? → YES.** It is the field that lets another agent
   decide to *wait* vs. *pick other work* — the core value of the format
   (vision + roadmap principle "intent is first-class"). A claim without intent
   is invalid.
2. **Glob syntax subset → a documented minimal subset.** v0.1 commits to:
   `**` (matches any number of path segments, including zero), `*` (matches
   within a single segment, never crossing `/`), and concrete literal paths.
   The validator rejects unsupported glob metacharacters (`?`, `[`, `]`, `{`,
   `}`) with `INVALID_GLOB`, so a malformed glob is caught at claim time rather
   than silently mis-matching later in `check`. This pins exactly what `check`'s
   glob-intersection core (#3) must implement.
3. **Default `ttl_seconds` → 1800 (30 min).** Matches the roadmap lean. Note:
   the *default* is applied by the `claim` command (#2); the schema only
   requires `ttl_seconds` to be present and a positive integer. Documented here
   so #2 inherits it.
4. **Structured-error format → `{ path, code, message }`, all errors reported.**
   (See table above.) Chosen over throwing so harnesses can inspect and a human
   can fix everything at once.
5. **Does `validateRegistry` enforce `id` uniqueness? → YES.** The registry
   passed to `validateRegistry` is the *resolved* set of claims; a duplicate
   `id` signals corruption or a double-append and is a `DUPLICATE_ID` error.
   (How the append-only JSONL log collapses to this resolved array is defined in
   registry issue #4; this validator operates on the parsed array.)

Additional decisions taken to remove ambiguity for the implementer:
- **Cross-field consistency:** `expires` must equal `created + ttl_seconds`
  (compared as epoch ms) → else `EXPIRES_MISMATCH`; and both must be valid ISO
  8601 with an explicit UTC `Z`.
- **Unknown top-level fields are rejected** (`UNKNOWN_FIELD`) to keep the open
  format tight and well-defined for v0.1. Forward-compatible extension comes via
  explicit versioning later, not silent extra keys.

## Acceptance criteria
- [ ] `validateClaim(obj)` and `validateRegistry(arr)` are exported from the
      package, are pure (no I/O, no throw on bad input), and add **zero runtime
      dependencies**.
- [ ] A fully-valid claim returns `{ valid: true, errors: [] }`; a valid
      registry (array of valid, unique-id claims) does too.
- [ ] Every required field, when missing, wrong-typed, empty, or out-of-enum,
      produces a structured error with the correct `path` and `code`.
- [ ] `intent` is required; an empty or absent `intent` is invalid.
- [ ] `globs` must be a non-empty array of non-empty strings restricted to the
      documented subset; unsupported metacharacters yield `INVALID_GLOB`.
- [ ] `ttl_seconds` must be an integer > 0.
- [ ] `created`/`expires` must be ISO 8601 UTC; `expires` must equal
      `created + ttl_seconds`.
- [ ] `status` must be one of `active` | `released` | `expired`.
- [ ] Unknown top-level fields produce `UNKNOWN_FIELD`.
- [ ] `validateRegistry` reports per-element errors with an indexed `path`
      (`[2].field`) and flags duplicate `id`s with `DUPLICATE_ID`.
- [ ] Validators return **all** violations, not just the first.
- [ ] `worklease validate <file>` auto-detects claim (object) vs registry
      (array), prints readable errors, exits `0`/`1`, and supports `--json` for
      machine-readable output. Missing file and malformed JSON produce a clear
      error and exit `1`.
- [ ] `npm test` passes with tests covering every code above.

## Non-goals
- **Not** verifying that `id` is a *correct* content hash — the hashing scheme
  is defined by the `claim` command (#2); here `id` is only required to be a
  non-empty string.
- **Not** the registry file format / append-only JSONL / hash-chaining / TTL
  expiry engine — that is registry issue #4. This issue validates the *parsed*
  claim/array shape.
- **Not** glob *intersection* / overlap logic — that is `check` (#3). This issue
  only validates that each glob is well-formed under the documented subset.
- **Not** implementing `claim`, `check`, `release`, or `conformance`.
- **Not** applying the `ttl_seconds` default (that lives in `claim`, #2).

## Open questions (for the human gate)
The spec is written around the recommended answers above; these are the ones a
reviewer may still want to overrule:
- **Strictness on unknown fields** — reject (chosen) vs. ignore for
  forward-compat. Chosen: reject, for a tight v0.1 format.
- **Timezone strictness** — require UTC `Z` (chosen) vs. accept any valid ISO
  8601 offset. Chosen: `Z`-only, for deterministic hashing/comparison.
- **`expires` consistency as hard error vs. warning** — chosen: hard error
  (`EXPIRES_MISMATCH`), since all three time fields are declared and the
  content-hash `id` depends on them agreeing.
