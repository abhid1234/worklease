# Product spec — Issue #2: `worklease claim` (declare intent to edit file globs)

## Problem / motivation
The schema (#1) defines what a claim *is*; `check` (#3) reads active claims to
prevent collisions. But nothing yet **creates** a claim. `claim` is the write
verb of the coordination format: before an agent starts editing, it files a
claim — "I intend to touch `src/auth/**` for the next 20 minutes, to add OAuth"
— to the shared registry so other agents can see it and steer clear. Without it
the registry is always empty and every `check` trivially reports clear. This
issue delivers the pure claim constructor plus the CLI verb that writes a
validated claim to the registry.

## Desired behavior
From the CLI:

```
worklease claim <globs...> --intent "<why>" [--ttl 20m] [--agent <id>]
                           [--registry <path>] [--json]
```

- Files a claim for one or more globs and prints the created claim (its `id`,
  `expires`, and a one-line summary), then exits `0`.
- `--intent` is **required** (a claim without intent is invalid per #1).
- `--ttl` is optional, default **30m** (`1800` seconds — the roadmap lean and
  the default documented in #1). Accepts a shorthand duration *or* raw seconds
  (see TTL decision below).
- `--agent` identifies who is filing; falls back to the `WORKLEASE_AGENT`
  environment variable. If neither is set, the command errors (a claim must name
  its agent).
- `--registry <path>` selects the registry file; defaults to the
  `WORKLEASE_REGISTRY` env var or `.worklease/registry.jsonl` — the same
  resolution `check` (#3) already uses.
- `--json` prints the created claim object as JSON instead of the human summary.

The written claim is a fully-valid claim record per #1:
`{ id, agent, globs, intent, ttl_seconds, created, expires, status: "active" }`
where:
- `created` is the current time as whole-second ISO 8601 UTC (`…Z`).
- `expires` is `created + ttl_seconds` (exactly, so it satisfies #1's
  `EXPIRES_MISMATCH` cross-check by construction).
- `id` is a **deterministic content hash** of the claim's identifying content
  (`agent`, `globs`, `intent`, `ttl_seconds`, `created`): the same inputs always
  produce the same `id`; changing any of them changes the `id`.
- `status` is always `"active"` on creation.

The claim is appended to the registry as one JSON line (append-only; never an
in-place rewrite), so two agents claiming concurrently cannot corrupt the file.

The pure library function `makeClaim(globs, meta)` builds this record with no
I/O and no clock (time is passed in via `meta.created`), so it is deterministic
and unit-testable; the CLI is the only part that reads the clock and touches the
filesystem.

## TTL input format (the issue's open question — decided)
**Accept both a compact duration shorthand and raw integer seconds.** Supported
forms: `<n>s`, `<n>m`, `<n>h` (e.g. `90s`, `20m`, `2h`) and a bare positive
integer interpreted as **seconds** (e.g. `1800`). Any other unit, a non-integer,
zero, or a negative value is a clear error and no claim is written.

Rationale: the roadmap, vision, and this issue's own title all show `--ttl 20m`,
so humans expect the shorthand; supporting bare seconds keeps the field a thin
mirror of the schema's `ttl_seconds` for scripts and harnesses. Rejected
alternatives: *seconds-only* (contradicts every documented example, poor human
ergonomics); *a full duration grammar* like `1h30m` (more surface than v0.1
needs — revisit if asked).

## Acceptance criteria
- [ ] A pure `makeClaim(globs, meta)` is exported from the package, takes no
      I/O and no ambient clock (`created` is supplied in `meta`), adds **zero
      runtime dependencies**, and returns a claim object that passes
      `validateClaim` from #1.
- [ ] `makeClaim` computes `expires = created + ttl_seconds` exactly (equal epoch
      ms), sets `status: "active"`, and sets `id` to a deterministic content hash
      of (`agent`, `globs`, `intent`, `ttl_seconds`, `created`).
- [ ] **id stability:** identical inputs → identical `id`; changing any hashed
      field (including `created`) changes the `id`. Two claims filed at different
      times therefore get different ids.
- [ ] `worklease claim <globs...> --intent "…"` writes one validated JSON line to
      the registry and prints the created claim; exit `0`.
- [ ] `--ttl` accepts `<n>s`/`<n>m`/`<n>h` and bare integer seconds; default is
      `1800` (30m) when omitted; invalid ttl → clear error, nothing written,
      exit `1`.
- [ ] `--intent` is required; missing intent → clear error, exit `1`.
- [ ] `--agent` resolves from the flag or `WORKLEASE_AGENT`; if neither is set →
      clear error, exit `1`.
- [ ] Registry path resolves from `--registry`, else `WORKLEASE_REGISTRY`, else
      `.worklease/registry.jsonl`; the parent directory is created if missing;
      the claim is **appended** (existing lines untouched).
- [ ] The command validates the constructed claim (via #1's `validateClaim`)
      before writing; an invalid claim (e.g. an unsupported glob metacharacter)
      is reported and **not** appended, exit `1`.
- [ ] `--json` prints the created claim object as JSON.
- [ ] `npm test` passes with tests covering id-stability, expiry computation,
      ttl parsing, validation-before-write, and the CLI round-trip.

## Non-goals
- **Not** conflict detection — `claim` does not `check` for overlap before
  writing (that is `check`, #3, and stays a separate step). Whether a harness
  runs `check` before `claim` is the harness's choice.
- **Not** the registry read/resolve/`list`/`release`/TTL-expiry engine — that is
  registry issue #4. This issue only *appends* a line; #4 owns the durable store,
  concurrency guarantees, and lifecycle reads. `claim` uses a minimal interim
  appender until #4 lands (mirroring how #3 shipped an interim reader).
- **Not** re-defining the claim shape or the validator — those are #1; `claim`
  consumes them.
- **Not** verifying that the globs match real files on disk (a claim may name a
  file that doesn't exist yet — that's the point of a pre-edit claim).
- **Not** a `release`/`expire` transition — `claim` only creates `active` claims.

## Open questions (for the human gate)
The spec is written around the recommended answers; a reviewer may overrule:
- **id hash algorithm & length** — recommended: SHA-256 (via Node's built-in
  `node:crypto`, not an npm dependency) over a canonical JSON serialization of
  the hashed fields, truncated to the first 16 hex chars. A reviewer may prefer
  the full digest or a different length. (The exact digest is an implementation
  detail #1 doesn't constrain — #1 only requires `id` to be a non-empty string.)
- **`created` precision** — recommended: floor to whole seconds for clean
  registry lines and stable hashing. A reviewer may prefer millisecond precision
  (also valid under #1's regex).
