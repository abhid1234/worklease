# Technical spec — Issue #2: `worklease claim`

## Approach
One new pure module plus a CLI verb. `src/claim.js` holds the deterministic core
— `makeClaim(globs, meta)` (build a valid claim record) and `parseTtl(input)`
(duration → integer seconds) — with **no I/O and no clock**: `created` is passed
in via `meta`, so `expires` and the content-hash `id` are fully determined by the
inputs and unit-testable. `bin/worklease.js` gains a `claim` subcommand that is
the only part with side effects: it reads the clock (`created = now`), parses
flags, calls the core, runs #1's `validateClaim` on the result, and — only if
valid — **appends** the claim as one JSON line to the registry file. Everything
stays inside the committed glob subset from #1; validation before write means an
unsupported glob is rejected rather than silently written.

The `id` is a content hash computed with Node's built-in `node:crypto`
(`node:` core module, not an npm dependency — the same category as the
`node:fs`/`node:path` already imported by the CLI), so the zero-runtime-dependency
constraint holds.

### `makeClaim(globs, meta)` — `src/claim.js` (pure)
```
meta = { agent, intent, ttl_seconds, created }   // created: ISO-8601-UTC string
makeClaim(globs, meta):
  expires = isoAddSeconds(created, ttl_seconds)          // created + ttl, whole ms
  id      = claimId({ agent, globs, intent, ttl_seconds, created })
  return { id, agent, globs, intent, ttl_seconds, created, expires, status: "active" }
```
- Field order matches #1's `CLAIM_FIELDS` (id, agent, globs, intent,
  ttl_seconds, created, expires, status).
- `expires`: `new Date(Date.parse(created) + ttl_seconds*1000).toISOString()`.
  With whole-second `created` and integer `ttl_seconds`, `expires ===
  created + ttl_seconds*1000` in epoch ms, so #1's `EXPIRES_MISMATCH` check
  passes by construction.
- Pure and total: `makeClaim` does not throw and does no validation itself —
  the CLI validates the finished record via #1's `validateClaim` and gates the
  write on it. (Keeps the core consistent with the family's non-throwing style;
  the validator is the single source of truth for validity.)

### `claimId(hashed)` — deterministic content hash
```
claimId({ agent, globs, intent, ttl_seconds, created }):
  canonical = JSON.stringify([agent, globs, intent, ttl_seconds, created])
  return sha256hex(canonical).slice(0, 16)
```
- Hash covers exactly the identifying content; `expires` (derived) and `status`
  (lifecycle) are excluded so they don't perturb the id.
- Canonical form is a fixed-order JSON array (not the claim object) so key
  ordering can never change the digest. `globs` is hashed in the order given.
- Same inputs → same id (id-stability); any change → different id. Because
  `created` is part of the hash, two otherwise-identical claims filed at
  different times get different ids.
- SHA-256 via `import { createHash } from "node:crypto"`; truncated to 16 hex
  chars (see PRODUCT open question — length is tunable).

### `parseTtl(input)` — duration → integer seconds (pure)
```
parseTtl(input):            // input: string (or number)
  if bare positive integer (e.g. "1800" | 1800): return that integer
  if /^(\d+)(s|m|h)$/:      return n * {s:1, m:60, h:3600}[unit]
  otherwise:                return null    // caller reports the error
```
- Returns `null` (not throw) on anything invalid — bad unit, non-integer,
  zero/negative, empty — so the CLI can print one clear error and exit `1`.
- Default lives in the CLI, not here: when `--ttl` is omitted the CLI uses
  `1800`.

### CLI — `bin/worklease.js` `claim` subcommand
- **Parse args:** positional `<globs...>`; flags `--intent <str>` (required),
  `--ttl <dur>` (default `1800` via `parseTtl`), `--agent <id>` (fallback
  `process.env.WORKLEASE_AGENT`), `--registry <path>`, `--json`. Reuse the same
  registry-path resolution helper as `check` (`--registry` → `WORKLEASE_REGISTRY`
  → `.worklease/registry.jsonl`).
- **Validate inputs:** at least one glob, non-empty `--intent`, a resolvable
  `--agent`, and a non-null `parseTtl(--ttl)`. Any failure → usage/error on
  stderr, exit `1`, nothing written.
- **Build:** `created = ` current time floored to whole seconds as ISO-8601 UTC
  (`new Date(Math.floor(Date.now()/1000)*1000).toISOString()`);
  `claim = makeClaim(globs, { agent, intent, ttl_seconds, created })`.
- **Validate output:** `validateClaim(claim)` (#1). If invalid (e.g. a glob with
  `? [ ] { }` → `INVALID_GLOB`), print the errors, exit `1`, **do not write**.
- **Append:** ensure the registry's parent dir exists (`mkdirSync(dir, {
  recursive: true })`), then `appendFileSync(path, JSON.stringify(claim) + "\n")`.
  Append-only — existing lines are never rewritten, so concurrent claims can't
  corrupt the file. (Registry issue #4 owns the durable store; this interim
  appender is deliberately minimal and isolated, mirroring #3's interim reader,
  so #4 can replace it without touching the core.)
- **Print:** `--json` → `JSON.stringify(claim)`; otherwise a readable line, e.g.
  `filed <id> — <agent> holds <globs> — "<intent>" (expires <expires>)`.
  Exit `0`.

## Files / functions to touch
- **`src/claim.js`** (new) — `makeClaim(globs, meta)`, `parseTtl(input)`, and
  the internal `claimId(hashed)` / `isoAddSeconds` helpers. Imports only
  `node:crypto` (`createHash`).
- **`src/index.js`** (edit) — also re-export `makeClaim` and `parseTtl` alongside
  the existing schema / `check` exports.
- **`bin/worklease.js`** (edit) — add the `claim` subcommand + the interim JSONL
  appender; extend the usage text. Reuse the existing `defaultRegistryPath`
  helper from the `check` implementation.
- **`test/claim.test.js`** (new) — unit tests for `makeClaim`, `claimId`
  stability, expiry computation, and `parseTtl`.
- **`test/cli.test.js`** (edit) — `claim` CLI cases against temp fixture
  registries (append, validation gating, ttl parsing, `--json`, error exits).
- **`README.md`** (update at implementation time, **not** in this spec PR) — a
  short `claim` usage block.

No `package.json` changes needed: `main`, `bin`, `type: module`, and `test:
node --test` are already correct, and `node:crypto` is a built-in.

## Test plan
Run with `npm test` (`node --test`).

**`makeClaim` / `claimId` (`test/claim.test.js`)**
- A built claim passes `validateClaim` (round-trip with #1).
- `expires === created + ttl_seconds` (epoch-ms equality) for several ttls.
- `status` is `"active"`; field set/order matches `CLAIM_FIELDS`.
- **id-stability:** same `(agent, globs, intent, ttl_seconds, created)` → same
  `id` across calls.
- **id-sensitivity:** changing each hashed field in turn (agent, a glob, intent,
  ttl_seconds, created) changes the `id`; changing nothing else does not.
- Two claims with different `created` → different ids.

**`parseTtl`**
- `"20m"` → 1200, `"2h"` → 7200, `"90s"` → 90, `"1800"` → 1800, `1800` → 1800.
- `"0"`, `"-5m"`, `"1.5m"`, `"20x"`, `""`, `"m"`, `"abc"` → `null`.

**CLI (`test/cli.test.js`)**
- `claim src/auth/** --intent "add OAuth" --ttl 20m --agent a1 --registry <tmp>`
  → exit `0`, one JSON line appended, line parses to a claim that passes
  `validateClaim` with `status:"active"` and correct `expires`.
- A second `claim` appends a second line (existing line preserved; append-only).
- `--json` prints the claim object (parseable, matches the written line).
- Default ttl: omitting `--ttl` yields `ttl_seconds === 1800`.
- `--agent` from `WORKLEASE_AGENT` env works identically to the flag.
- Missing `--intent` / missing agent / invalid `--ttl` / no globs → clear error,
  exit `1`, **nothing appended**.
- Invalid glob (`"src/**/*.ts?"`) → `INVALID_GLOB` reported, exit `1`, nothing
  appended.
- Registry parent dir auto-created when it doesn't exist.
- A written claim is immediately visible to `check` (append a claim, then
  `check` an overlapping glob as a *different* agent → conflict; as the *same*
  agent → clear) — proves the two verbs agree on the on-disk format.

## Risks / edge cases / migrations
- **Registry coupling to #4.** `claim`'s core is fully testable now; only the
  CLI's append depends on the store. The interim appender (mkdir + append one
  JSON line, no locking) matches #3's interim reader and is swappable for #4's
  writer without touching `makeClaim`. Documented so shipping #2 before #4 is not
  blocked.
- **Concurrency.** Append-only single-line writes with a content-hash `id` mean
  two agents appending at once can't merge-conflict or lose a claim; the file
  stays a valid JSONL log (#4 formalizes read-time resolution and TTL expiry).
  `appendFileSync` of one `write(2)`-sized line is atomic enough for the local
  interim store; #4 owns any stronger guarantee.
- **id determinism vs. collisions.** A 16-hex-char (64-bit) SHA-256 prefix makes
  accidental collisions negligible for a repo-scale registry; because `created`
  is in the hash, even identical re-claims differ. Full-length digest is
  available if a reviewer wants more margin (PRODUCT open question).
- **`created` precision & `expires` equality.** Flooring `created` to whole
  seconds keeps registry lines clean and guarantees exact epoch-ms equality with
  `expires`; #1's regex also permits sub-second, so millisecond precision would
  still validate if chosen instead.
- **Glob validation timing.** Validating the *constructed* claim (not just raw
  args) reuses #1's single source of truth and catches unsupported
  metacharacters before anything is written — no partial/invalid registry lines.
- **Zero-dep hashing.** `node:crypto` is a core module (like `node:fs`), so no
  npm dependency is added; a hand-rolled hash was considered and rejected as
  needless risk when a vetted built-in exists.
- **No migrations.** Greenfield module; no persisted data format changes (the
  registry line format is exactly #1's claim shape, already consumed by #3).

## Alternatives considered
- **Read the clock inside `makeClaim`** — rejected: kills determinism and
  testability; injecting `created` keeps the core pure (the family pattern, same
  as `check`'s injected `now`).
- **`makeClaim` throws on invalid input** — rejected: the family's core never
  throws; the CLI gates the write on #1's `validateClaim`, keeping one source of
  truth for validity.
- **Hash the whole claim object (incl. `expires`/`status`)** — rejected:
  `expires` is derived and `status` is lifecycle; hashing a fixed-order array of
  the identifying fields keeps the id stable and key-order-independent.
- **TTL seconds-only** — rejected: contradicts every documented `--ttl 20m`
  example and hurts human ergonomics.
- **Full duration grammar (`1h30m`)** — rejected: more surface than v0.1 needs;
  `<n>s|m|h` + bare seconds covers the examples.
- **`claim` also runs `check` and refuses on conflict** — rejected: conflates two
  verbs; `check` is a separate, advisory step a harness composes as it wishes
  (claim stays a pure write).
- **A non-crypto/random id** — rejected: the format calls for a *content-hash*
  id (roadmap/vision), which gives determinism and dedupe for free; randomness
  would break id-stability tests and the append-only content-addressing story.
