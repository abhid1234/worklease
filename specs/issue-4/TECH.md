# Technical spec — Issue #4: the append-only registry (`list`, `release`, TTL expiry)

## Approach
One new module, `src/registry.js`, holds the store: a small set of pure
functions (hashing, canonical serialization, log resolution) plus a thin I/O
layer (`appendRecord`, `loadRegistry`) that keeps all filesystem access in one
place. The design is deliberately lock-free: writes are single-line appends
(`O_APPEND`), reads fold the whole log into the current claim array, and every
record self-identifies by a content hash so concurrent or duplicated appends
resolve cleanly instead of conflicting. `bin/worklease.js` gains `list` and
`release` subcommands and swaps `check`'s interim JSONL reader for
`loadRegistry`, centralizing the default registry path so `check`, `list`, and
`release` all agree on it. Hashing uses Node's built-in `node:crypto`, which is
part of the runtime — no added dependency, consistent with the family constraint.

## Record model
Append log = JSONL, one record per line. Two record types:

```jsonc
// claim record (written by #2; #4 provides the append primitive)
{ "id": "<sha256>", "agent": "a1", "globs": ["src/auth/**"], "intent": "add OAuth",
  "ttl_seconds": 1200, "created": "2026-07-11T20:00:00Z",
  "expires": "2026-07-11T20:20:00Z", "status": "active" }

// release record (written by #4's `release`)
{ "id": "<sha256>", "type": "release", "claim_id": "<claim sha256>",
  "agent": "a1", "at": "2026-07-11T20:10:00Z" }
```
A record is a **claim** iff it has no `type` field (or `type: "claim"`); a
**release** iff `type === "release"`. Unknown `type` values are skipped with a
note (forward-compat).

## Pure core (`src/registry.js`)

### `canonicalize(obj)` / `computeRecordId(record)`
- `canonicalize` → deterministic JSON string with **sorted keys** and no
  incidental whitespace, over the record **excluding its `id`**.
- `computeRecordId(record)` = `crypto.createHash("sha256").update(canonicalize(recordWithoutId)).digest("hex")`.
- Deterministic and content-addressed: identical content ⇒ identical id. `#2`'s
  `claim` uses the same helper so a claim's `id` **is** its content hash,
  satisfying #1's "id is a content hash" note with one shared implementation.

### `resolveRecords(records, { now })` → `{ claims, notes }`
`records` is an already-parsed array (order = append order). Pure; injects `now`
(epoch ms) so expiry is deterministic in tests. Algorithm:
1. **Integrity filter.** For each record, if `record.id !== computeRecordId(record)`
   push a `note` (`"skipped record N: id/content mismatch"`) and drop it. (Parse
   failures are handled by the caller/loader, which passes only parsed lines.)
2. **Fold claims.** Walk records in order; for each claim record keep the latest
   by `id` in a `Map` (later line wins for the same id — normally identical since
   id is content-addressed, but tolerant of a re-append).
3. **Apply releases.** For each `release` record whose `claim_id` is a known
   claim, set that claim's stored status to `released` and record `released_by` /
   `released_at`. A release for an unknown `claim_id` → note, ignored. Add a note
   if `release.agent` differs from the claim's `agent` (advisory ownership hint).
4. **Derive TTL expiry.** For each claim still `active`, if
   `Date.parse(expires) <= now` set effective `status: "expired"` (derived, not
   written) and add a note. Released claims stay `released`.
5. Return `claims` = the resolved array (each with effective `status`), sorted by
   `expires` ascending, plus the collected `notes`.

`resolveRecords` never throws on bad field values — a claim missing `expires`
simply isn't derived to expired; integrity + #1's validator (optional at load)
guard shape. The function is the single source of truth for "current state,"
reused by `list`, `release`, and `check`.

### `listActive(claims)` / helpers
Small pure selectors used by the CLI: `claims.filter(c => c.status === "active")`,
plus `formatRelative(expires, now)` (`"in 12m"`, `"in 40s"`, `"expired"`) and
`shortId(id)` (first 8 hex chars). Kept pure for direct unit testing.

## I/O layer (`src/registry.js`)

### `defaultRegistryPath(cwd = process.cwd())`
Returns `process.env.WORKLEASE_REGISTRY` if set, else
`path.join(cwd, ".worklease", "registry.jsonl")`. The **one** place the default
path is defined; `check`, `list`, and `release` all call it.

### `appendRecord(path, record)`
1. If `record.id` is absent, set `record.id = computeRecordId(record)`.
2. `fs.mkdirSync(dirname(path), { recursive: true })`.
3. `fs.appendFileSync(path, JSON.stringify(record) + "\n")` — opened with the
   `"a"` flag (`O_APPEND`); a single, whole-line write. Never opens for rewrite.
4. Return the stored record (with id). Used by `release` here and by `claim` (#2).

### `loadRegistry(path, { now })` → `{ claims, notes }`
1. Read the file; `ENOENT` → treat as empty (`{ claims: [], notes: [] }`).
2. Split on `\n`, drop blank lines; `JSON.parse` each — a line that throws is
   dropped with a note (`"skipped unparseable line N"`), never aborts the load.
3. Call `resolveRecords(parsed, { now })`, merge parse notes with resolve notes.
Returns the resolved current registry. This replaces #3's interim reader.

## CLI — `bin/worklease.js`

### `list`
- Flags: `--all`, `--agent <id>`, `--json`, `--registry <path>`.
- `const { claims, notes } = loadRegistry(registryPath, { now: Date.now() })`.
- Filter: default `status === "active"`; `--all` keeps all; `--agent` narrows by
  holder. Sort by `expires` ascending (already sorted by resolve).
- `--json` → print the (filtered) claim array. Else a table: `agent  globs
  intent  expires-in  id8`, one row per claim; empty → `no active claims`.
  Surface `notes` (expired/skipped) to stderr under `--all` or a `--verbose`.
- Exit `0`.

### `release <id>`
- Positional `<id>` (full or unambiguous prefix); flags `--agent`
  (`WORKLEASE_AGENT` fallback), `--json`, `--registry`.
- Load registry; resolve `<id>` against claim ids by exact match, else unique
  prefix. **Ambiguous** prefix or **unknown** id → error to stderr, exit `1`.
- If the target's effective status is already `released` or `expired` → print a
  note ("already released" / "already expired — nothing to do"), **no append**,
  exit `0`.
- Otherwise build `release = { type: "release", claim_id: id, agent, at: new Date(now).toISOString() }`,
  `appendRecord(registryPath, release)`, print `released <id8> (held by <agent>)`
  or, under `--json`, the appended record. Exit `0`.
- Missing `--agent` → use `"unknown"` (advisory; noted), consistent with #3's
  safe-default posture.

### `check` (edit)
- Replace the interim per-line reader with
  `loadRegistry(registryPath, { now: Date.now() })`; pass `claims` straight into
  the existing `check(globs, claims, { agent, now })`. Default `registryPath`
  now comes from `defaultRegistryPath()`. No change to `check`'s core or output.

## Files / functions to touch
- **`src/registry.js`** (new) — `computeRecordId`, `canonicalize`,
  `resolveRecords`, `listActive`, `formatRelative`, `shortId` (pure);
  `defaultRegistryPath`, `appendRecord`, `loadRegistry` (I/O). Imports only
  `node:crypto`, `node:fs`, `node:path`.
- **`src/index.js`** (edit) — re-export `computeRecordId`, `resolveRecords`,
  `loadRegistry`, `appendRecord`, `defaultRegistryPath` alongside the existing
  schema / glob / check exports.
- **`bin/worklease.js`** (edit) — add `list` and `release` subcommands; switch
  `check` to `loadRegistry` + `defaultRegistryPath`; extend usage text.
- **`test/registry.test.js`** (new) — pure core + I/O against temp files.
- **`test/cli.test.js`** (edit) — `list` / `release` cases; update `check`'s CLI
  cases to write a real `.worklease/registry.jsonl` fixture (or `--registry`).
- **`.gitignore`** (edit at implementation time) — ensure `.worklease/` is **not**
  ignored so the registry is shareable; `*.log` already there won't catch it.
- **`README.md`** (update at implementation time, not this spec PR) — `list` /
  `release` usage + a note that the registry is a committed JSONL file.

`package.json` needs no change (`main`, `bin`, `type: module`, `node --test` are
already correct).

## Test plan
Run with `npm test` (`node --test`).

**Pure core (`resolveRecords` / hashing)**
- `computeRecordId` is deterministic and key-order-independent; two records with
  identical content (different key order) hash equal; changing any field changes
  the id.
- Single active claim, `now` before `expires` → one active claim.
- Same claim + a matching `release` record → status `released`; excluded from
  active.
- Active claim with `expires <= now` → derived `expired` + a note; log unchanged.
- Duplicate claim record (same id appended twice) → one claim (idempotent).
- Two distinct claims → both present, sorted by `expires`.
- `release` for unknown `claim_id` → ignored + note.
- `release` by a different agent than the holder → applied + ownership note.
- Integrity: record whose `id` doesn't match its content → skipped + note; the
  rest of the registry still resolves.
- Unknown `type` → skipped + note.

**I/O (`appendRecord` / `loadRegistry`)**
- `loadRegistry` on a missing file → `{ claims: [], notes: [] }`, no throw.
- `appendRecord` twice then `loadRegistry` → both records present and resolved;
  file has exactly two lines, each ending in `\n`; **first line unchanged** after
  the second append (append-only invariant asserted by re-reading raw bytes).
- Unparseable line (hand-written garbage) in the file → skipped + note, other
  lines resolve.
- `appendRecord` creates `.worklease/` when absent.
- `defaultRegistryPath` honors `WORKLEASE_REGISTRY` and falls back to
  `.worklease/registry.jsonl`.

**CLI (`test/cli.test.js`, child-process against temp `--registry` fixtures)**
- `list` empty registry → `no active claims`, exit `0`; `--json` → `[]`.
- `list` with active + released + expired claims → default shows only active;
  `--all` shows all with labels; `--agent` filters; `--json` parses to the
  resolved array; sorted by soonest expiry.
- `release <full-id>` → appends a release record, exit `0`; a following `list`
  no longer shows the claim; the raw file gained one line and lost none.
- `release <unambiguous-prefix>` → same; ambiguous prefix → exit `1`; unknown id
  → exit `1`.
- `release` of an already-released/expired claim → note, no new line, exit `0`.
- `check` now reads the same `.worklease/registry.jsonl` (integration: `claim`-
  style record written via `appendRecord` fixture, `check` sees / clears it).

## Risks / edge cases / migrations
- **Concurrency guarantee & its limits.** `fs.appendFileSync` opens with
  `O_APPEND`, so each single-line write lands atomically at end-of-file on local
  POSIX filesystems for writes below `PIPE_BUF` (a claim line is well under it) —
  interleaving is avoided and no locking is needed. This is documented as the
  guarantee; exotic network filesystems that don't honor `O_APPEND` atomicity are
  out of scope for v0.1. Content-hash ids are the backstop: even a torn/duplicate
  line resolves idempotently or is dropped by the integrity check, never
  corrupting other claims.
- **Append-only is the whole safety story.** The store must never open the file
  for rewrite/truncate. A raw-bytes test asserts prior lines are byte-identical
  after a later append, guarding the invariant against regressions.
- **Log growth.** The append log grows unbounded (releases/expiries add lines,
  never remove). Acceptable for v0.1; compaction/GC is an explicit non-goal.
  `resolveRecords` is O(n) over the log, fine at fleet scale.
- **Clock / TTL.** Expiry is derived from an injected `now`; only the CLI reads
  the real clock (`Date.now()`), keeping the core deterministic — same discipline
  as #3. A claim exactly at `expires === now` is treated as expired (`<=`).
- **Roadmap "hash-chained" wording.** Implemented as per-record content hashing,
  not a linked chain — see PRODUCT locked decision 3; called out so a reviewer
  can confirm.
- **`.worklease/` must be tracked.** If a repo's `.gitignore` hides dotdirs the
  registry won't be shared; the implementation note ensures it's committed. This
  is the only "migration": creating the directory on first append.
- **Shared hashing with #2.** `computeRecordId` is the single hasher; #2's
  `claim` must use it so claim ids stay content-addressed and consistent. Noted
  as a cross-issue contract, not implemented here.

## Alternatives considered
- **Linked hash-chain (blockchain-style prev-hash per line)** — rejected: forks
  under concurrent appends, reintroducing the merge conflict the format exists to
  prevent (contradicts design principle #1). Per-record content hashing gives
  tamper-evidence without cross-line coupling.
- **In-place status edit on `release` / an expiry sweep that rewrites the file**
  — rejected: any rewrite can race a concurrent append and lose a claim. Append a
  release record; derive expiry on read.
- **A lock file / broker process for concurrency** — rejected: adds a daemon and
  a dependency-shaped surface; `O_APPEND` + content-hash ids give conflict-free
  writes with none of it (and vision explicitly lists "not a broker").
- **Local ignored registry file** — rejected: invisible to other worktrees/
  harnesses, defeating the point; git-tracked JSONL is shareable and conflict-free.
- **Rebuild `check`'s reader independently** — rejected: #3 deliberately isolated
  its interim reader to be swapped for this loader; one `loadRegistry` keeps a
  single default path and resolution rule across all three verbs.
- **`release` restricted to the holding agent** — rejected for v0.1: advisory
  cleanup across the fleet is useful; a mismatch is noted rather than blocked
  (flagged as an open question for a reviewer who wants stricter ownership).
