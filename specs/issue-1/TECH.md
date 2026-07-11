# Technical spec — Issue #1: the claim + registry schema and validator

## Approach
Hand-rolled, zero-dependency validators in a single pure module,
`src/schema.js`, re-exported from `src/index.js` (the package `main`). No
`ajv`, no JSON-Schema runtime — the family constraint is zero dependencies and
the surface is small enough to validate by hand and test exhaustively.
`validateClaim(obj)` and `validateRegistry(arr)` are pure functions that never
throw on bad input and always return `{ valid, errors }`, collecting **every**
violation rather than short-circuiting on the first. The CLI (`bin/worklease.js`)
adds only I/O: read a file, parse JSON, dispatch to the right validator by JSON
type, and print. All decisions from PRODUCT.md are encoded as explicit checks
with stable error `code`s.

### Validation contract
```
validateClaim(obj)     -> { valid: boolean, errors: Error[] }
validateRegistry(arr)  -> { valid: boolean, errors: Error[] }
Error = { path: string, code: string, message: string }
```
`code` ∈ `MISSING_FIELD`, `UNKNOWN_FIELD`, `WRONG_TYPE`, `NOT_OBJECT`,
`NOT_ARRAY`, `EMPTY_STRING`, `EMPTY_ARRAY`, `INVALID_ENUM`, `NOT_POSITIVE_INT`,
`INVALID_ISO8601`, `EXPIRES_MISMATCH`, `INVALID_GLOB`, `DUPLICATE_ID`.

### `validateClaim(obj)` checks (in order, all collected)
1. `obj` is a non-null plain object → else single `{ path: "", code: NOT_OBJECT }`.
2. For each of the 8 required fields: present → else `MISSING_FIELD`.
3. Any key not in the known set → `UNKNOWN_FIELD` at that key's path.
4. Per-field type/shape:
   - `id`, `agent`, `intent`: string; non-empty after trim → else `WRONG_TYPE` / `EMPTY_STRING`.
   - `globs`: array (`WRONG_TYPE`), length ≥ 1 (`EMPTY_ARRAY`); each element a
     non-empty string (`WRONG_TYPE`/`EMPTY_STRING` at `globs[i]`) matching the
     allowed-glob rule → else `INVALID_GLOB`.
   - `ttl_seconds`: integer and `> 0` → else `NOT_POSITIVE_INT`.
   - `created`, `expires`: match a strict ISO-8601-UTC regex **and** parse to a
     real date → else `INVALID_ISO8601`.
   - `status`: one of the three enum values → else `INVALID_ENUM`.
5. Cross-field: if `created`, `expires`, and `ttl_seconds` are individually
   valid, assert `Date.parse(expires) === Date.parse(created) + ttl_seconds*1000`
   → else `EXPIRES_MISMATCH`.

### Allowed-glob rule (validation only — not intersection)
A glob is valid iff it is a non-empty string containing none of the unsupported
metacharacters `? [ ] { }`. Supported tokens are `**`, `*`, `/`, and literal
path characters. Implemented as a single negative-character-class regex plus a
non-empty check. (Intersection semantics for these tokens are `check`'s job, #3;
this only guarantees `check` never receives syntax it hasn't committed to.)

### ISO-8601-UTC rule
Regex requiring `YYYY-MM-DDTHH:MM:SS(.sss)?Z` (UTC `Z` only), combined with
`!Number.isNaN(Date.parse(s))` to reject impossible dates like `2026-13-40`.
Bare `Date.parse` is too lenient on its own, so the regex gates format and the
parse gates real-calendar validity.

### `validateRegistry(arr)` checks
1. `arr` is an array → else single `{ path: "", code: NOT_ARRAY }`.
2. For each element `i`: run `validateClaim`, re-prefixing each returned error
   `path` with `[i]` (e.g. `globs[0]` → `[3].globs[0]`; `""` → `[3]`).
3. After per-element validation, collect `id`s of structurally-valid claims; any
   value appearing more than once yields `DUPLICATE_ID` at `[i].id` for each
   duplicate occurrence after the first.
4. `valid` is true iff no errors across all elements and no duplicates.

## Files / functions to touch
- **`src/schema.js`** (new) — the pure core. Exports:
  `validateClaim(obj)`, `validateRegistry(arr)`, and shared constants
  `STATUSES`, `CLAIM_FIELDS`, `ERROR_CODES`, plus internal helpers
  `isIso8601Utc(s)`, `isAllowedGlob(s)`. No imports.
- **`src/index.js`** (new) — public entry (`package.json` `main`). Re-exports
  the schema API: `export { validateClaim, validateRegistry } from "./schema.js"`.
- **`bin/worklease.js`** (new) — CLI entry (`package.json` `bin`). Implements
  the `validate <file>` subcommand: read file → `JSON.parse` → dispatch
  (`Array.isArray` → `validateRegistry`, plain object → `validateClaim`) →
  print. Flags: `--json` (emit `{ valid, errors }` as JSON). Exit `0` if valid,
  `1` if invalid / file-missing / parse-error. Unknown subcommand → usage + exit
  `1`. Node shebang `#!/usr/bin/env node`.
- **`test/schema.test.js`** (new) — `node --test` unit tests for the validators.
- **`test/cli.test.js`** (new) — `node --test` tests driving `bin/worklease.js`
  as a child process against temp fixture files.
- **`README.md`** (update, at implementation time) — add a short "validate"
  usage block and the claim field table. *(Not in this spec PR.)*

No changes to `package.json` needed: `main`, `bin`, `type: module`, and
`test: node --test` are already correct.

## Test plan
Run with `npm test` (`node --test`). Coverage:

**`validateClaim`**
- A fully-valid claim → `{ valid: true, errors: [] }`.
- Each required field missing → exactly one `MISSING_FIELD` at that path.
- Wrong types for each field (`globs` not array, `ttl_seconds` string, etc.).
- Empty `intent` / empty `agent` / empty `id` → `EMPTY_STRING`.
- `globs: []` → `EMPTY_ARRAY`; `globs: ["ok", ""]` → `EMPTY_STRING` at `globs[1]`.
- `globs: ["src/**/*.ts?"]` and each of `[ ] { }` → `INVALID_GLOB`.
- Valid globs `**`, `*`, `src/auth/**`, `config.js` all pass.
- `ttl_seconds` = `0`, `-1`, `1.5`, `"20"` → `NOT_POSITIVE_INT`.
- `created`/`expires` non-ISO, missing `Z`, `2026-13-40T…Z` → `INVALID_ISO8601`.
- `expires` not equal to `created + ttl_seconds` → `EXPIRES_MISMATCH`;
  exact-match case passes.
- `status: "done"` → `INVALID_ENUM`; each valid enum passes.
- Extra key `foo` → `UNKNOWN_FIELD`.
- Non-object input (`null`, `[]`, `42`, `"x"`) → `NOT_OBJECT`.
- Multiple simultaneous violations → all reported (assert error count/codes).

**`validateRegistry`**
- Valid array of valid, unique-id claims → valid.
- Non-array input → `NOT_ARRAY`.
- Element error path is prefixed (`[2].globs[0]`, `[1]`).
- Duplicate `id` across two elements → `DUPLICATE_ID`.
- Empty array `[]` → valid (no claims is a valid registry).

**CLI (`test/cli.test.js`)**
- Valid claim file → stdout ok, exit `0`.
- Invalid claim file → errors printed, exit `1`.
- Valid registry (array) file → exit `0`; invalid → exit `1`.
- `--json` emits parseable `{ valid, errors }`.
- Missing file → clear error, exit `1`.
- Malformed JSON → clear parse error, exit `1`.
- Auto-detection: object routes to claim, array routes to registry.

## Risks / edge cases / migrations
- **ISO 8601 without a dependency.** `Date.parse` alone accepts too much and
  varies by engine; mitigate with a strict regex + parse combo (above). Node
  ≥18 (the engines floor) parses ISO UTC consistently.
- **`expires` consistency vs. clock rounding.** Comparing epoch ms exactly is
  safe because `created`/`expires`/`ttl_seconds` are all declared, whole-second
  values; the `claim` command (#2) will compute `expires` from `created + ttl`,
  so exact equality holds by construction. Sub-second `created` is allowed by
  the regex but the equality still holds in ms.
- **Glob over-strictness.** Rejecting `? [ ] { }` could reject a real filename
  containing those characters; accepted trade-off for v0.1 given the documented
  subset. Revisit if a real path needs them (would need escaping semantics).
- **`Object` shape checks.** Guard against `null`, arrays, and non-plain objects
  explicitly (`typeof === "object" && !Array.isArray && !== null`).
- **No migrations.** Greenfield module; no persisted data or schema versions
  exist yet. (Format versioning is a future concern, noted in PRODUCT.md.)
- **Duplicate-id scope.** Uniqueness is checked only among structurally-valid
  claims so a malformed element doesn't mask a real duplicate elsewhere.

## Alternatives considered
- **JSON Schema + `ajv`** — rejected: adds a runtime dependency, violating the
  zero-dep constraint that defines the family.
- **Throw on invalid input** — rejected: harnesses need all errors at once and
  pure `{ valid, errors }` composes better than try/catch.
- **`intent` optional** — rejected: removes the field that lets an agent choose
  to wait vs. pick other work — the product's core value.
- **Parse raw JSONL inside `validateRegistry`** — rejected for #1: keep the core
  pure over an already-parsed array; file/JSONL parsing belongs to the CLI and
  to registry issue #4.
- **Lenient / ignore unknown fields** — rejected: a tight, well-defined format
  serves interop better in v0.1; extension comes via explicit versioning.
- **Separate `validate-claim` / `validate-registry` CLI verbs** — rejected in
  favor of one `validate` that auto-detects by JSON type, with `--json` for
  machine use; fewer verbs, matches the "small composable commands" convention.
