# Product spec — Issue #4: the append-only registry (`list`, `release`, TTL expiry)

## Problem / motivation
`claim` writes intent and `check` reads it — but neither can exist without the
thing in the middle: a **shared store** that many parallel agents append to at
once without ever corrupting it or losing a claim. This issue is that store: an
**append-only JSONL registry** plus the two lifecycle verbs that operate on it —
`worklease list` (who holds what, expiring when) and `worklease release <id>`
(drop a claim you're done with). The store's one non-negotiable property is that
concurrent writers cannot conflict: records are append-only, self-identified by a
content hash, and never edited in place — so two agents in two worktrees filing
or releasing claims at the same moment produce a file that resolves cleanly, not
a merge conflict or a dropped record. `check` (#3) already reads through a small
interim reader that this issue replaces with the real loader.

## Desired behavior

### The store
A registry is an **append-only JSONL file** (one JSON record per line). There
are two kinds of record:

| record | shape (fields) | written by |
|---|---|---|
| **claim** | a full claim: `{ id, agent, globs[], intent, ttl_seconds, created, expires, status: "active" }` (schema #1) | `claim` (#2); this issue provides the low-level append |
| **release** | `{ id, type: "release", claim_id, agent, at }` — a status-change record | `release` (this issue) |

Rules that make the store conflict-free and non-destructive:
- **Append-only.** New records are appended as whole lines; existing lines are
  **never** rewritten or deleted. `release` appends a `release` record — it does
  **not** edit the prior claim line.
- **Content-hash `id`.** Every record's `id` is the hash of its own content
  (canonical JSON, excluding `id`). Identical content → identical `id`, so a
  duplicated append (two agents filing the same claim, a retried write) is
  idempotent on read; distinct records get distinct ids and both survive.
- **Resolve on read.** The current state of the fleet is *computed* by folding
  the append log: latest claim record per `id`, with any `release` record for
  that id moving it to `released`, and any claim whose `expires` is in the past
  treated as `expired` (see TTL below). Nothing is written back during a read.

### `worklease list`
Shows the active claims — who holds what, and when each expires.
- **Default:** only **active** claims (status `active` **and** not past TTL),
  one row each: agent · globs · intent · relative expiry (`expires in 12m`) ·
  short id. Sorted by soonest expiry.
- `--all` — also include `released` and `expired` claims, each labeled with its
  effective status.
- `--agent <id>` — filter to a single holder.
- `--json` — emit the resolved claim array verbatim (each claim carries its
  effective `status`) for harness consumption.
- `--registry <path>` — override the registry location (default per TECH).
- Empty / missing registry → prints "no active claims" (and `[]` under `--json`),
  exit `0`.

### `worklease release <id>`
Drops a claim by appending a `release` record.
- Appends `{ id, type: "release", claim_id: <id>, agent, at }` — never touches
  the original claim line.
- `--agent <id>` (or `WORKLEASE_AGENT`) records who released it.
- Resolves the target by full `id`, or by an **unambiguous id prefix** (short
  ids shown by `list` are usable); an ambiguous prefix is an error.
- Releasing an already-`released` or already-`expired` claim is a **no-op** with
  a note (still exit `0` — the desired end state holds).
- Releasing an unknown id → error message, exit `1`.
- Prints a one-line confirmation; `--json` emits the appended release record.
- `--registry <path>` — override the registry location.

### TTL expiry (on read)
A claim with `status: "active"` whose `expires` is at/earlier than "now" is
treated as **inactive** ("expired") wherever the registry is resolved — by
`list`, by `release`, and by `check`. This is a *derived* status computed at read
time from the injected clock; the log is **not** rewritten (no expiry sweep, no
in-place mutation). This matches the roadmap lean ("expired = clear, with a
warning") and is already how `check` (#3) treats `expires <= now`.

## Locked product decisions
The issue raised two open questions; both are decided here (see Open questions
for what a reviewer may still overrule), plus a third that surfaced from the
roadmap's wording.

1. **Registry location → a git-tracked `.worklease/registry.jsonl` at the repo
   root (default).** Shareable across worktrees and harnesses, survives the
   session, and — because it is append-only with content-hash ids — a concurrent
   append in two worktrees union-merges cleanly rather than conflicting. It is
   meant to be **committed**, not gitignored. `--registry` / `WORKLEASE_REGISTRY`
   override the path (mirrors #3's `--agent` / `WORKLEASE_AGENT`). *Rejected: a
   local ignored file — invisible to the fleet, defeats the coordination point.*

2. **Expired-but-unreleased claim → treated as inactive on read, surfaced as a
   note.** A claim past its TTL that was never explicitly released is resolved to
   effective status `expired`: excluded from the default `list`, shown under
   `--all` labeled `expired`, and treated as clear by `check`. No rewrite. *This
   is consistent with #3 and needs no coordination between the two features.*

3. **Integrity → per-record content hash, NOT a linked hash-chain.** The roadmap
   phrases this feature as "hash-chained integrity," but a blockchain-style chain
   (each line references the previous line's hash) is in direct tension with the
   project's #1 design principle — *the registry never conflicts with itself*.
   A linked chain forks the moment two agents append concurrently, reintroducing
   exactly the merge conflict the format exists to avoid. Instead, each record is
   **self-verifying**: its `id` is the hash of its own content, so integrity is
   checked per line (recompute the hash, compare to `id`) with **no coupling
   between lines**. This keeps concurrent appends conflict-free by construction
   while still detecting a tampered or truncated record. A line that fails its
   integrity check (or won't parse) is skipped with a warning — one bad line
   never discards the rest of the registry.

## Acceptance criteria
- [ ] The registry is an append-only JSONL file; the store code **never**
      rewrites or deletes an existing line — `release` and expiry both work by
      appending / deriving, not editing.
- [ ] `computeRecordId(record)` produces a deterministic content hash (canonical
      JSON, `id` excluded); identical content yields an identical id, and it is
      used as every record's `id`. Zero runtime dependencies (Node built-in
      `crypto` only).
- [ ] A pure `resolveRecords(records, { now })` folds the append log into the
      current claim array: latest claim per id, `release` records applied,
      TTL-expired actives derived to `expired`, deduped by id. It never throws on
      a malformed record; corrupt / unparseable / hash-mismatched records are
      skipped and reported as notes.
- [ ] `loadRegistry(path, { now })` reads the JSONL file (missing file → empty
      registry), parses per line tolerantly, and returns the resolved claim
      array via `resolveRecords`.
- [ ] `appendRecord(path, record)` appends exactly one JSON line terminated by
      `\n`, creating the directory/file if absent, assigning the content-hash id,
      and never modifying prior lines.
- [ ] `worklease list` prints active claims (agent, globs, intent, relative
      expiry, short id) sorted by soonest expiry; supports `--all`, `--agent`,
      `--json`, `--registry`; empty/missing registry prints "no active claims" /
      `[]` and exits `0`.
- [ ] `worklease release <id>` appends a `release` record for the claim, supports
      full id and unambiguous prefix, records `--agent` / `WORKLEASE_AGENT`,
      no-ops with a note on an already-released/expired claim (exit `0`), errors
      on unknown or ambiguous id (exit `1`), and supports `--json` / `--registry`.
- [ ] TTL-expired claims are treated as inactive by `list` (default) and by
      `check`, without rewriting the log.
- [ ] `check`'s interim registry reader (from #3) is replaced by `loadRegistry`,
      and the default registry path is centralized in one place used by `check`,
      `list`, and `release`.
- [ ] Two sequential appends to the same file both survive and resolve (the
      append-only, id-keyed model is exercised); a duplicate append is idempotent
      on read.
- [ ] `npm test` passes with unit tests for the store core (resolution, expiry,
      release, integrity, missing file, dedupe) and the `list` / `release` CLI.

## Non-goals
- **Not** `claim` (#2). This issue provides the low-level `appendRecord` +
  `computeRecordId` that `claim` will reuse to write a claim record, but it does
  **not** implement the `claim` verb, the `ttl` default, or intent capture.
- **Not** re-defining or re-validating the claim shape — that is `validateClaim`
  (#1). The store may reuse #1's validator at load time, but claim-field rules
  live in #1.
- **Not** the glob-overlap / conflict logic — that is `check` (#3). This issue
  only *feeds* `check` a resolved registry.
- **Not** a broker process, lock file, or daemon. The store is a plain file;
  concurrency safety comes from append-only + content-hash ids, not locking.
- **Not** a compaction / garbage-collection tool for the append log (an old-
  record pruner is a later concern; the log grows monotonically for v0.1).
- **Not** enforcement — `release` and expiry are advisory bookkeeping, not locks.
- **Not** cross-line hash-chaining (see locked decision 3).

## Open questions (for the human gate)
Written around the recommended answers; a reviewer may overrule:
- **Registry location — git-tracked (chosen) vs. local ignored.** Chosen:
  git-tracked `.worklease/registry.jsonl`, committed, conflict-free by append.
- **Expired-but-unreleased on read — inactive + note (chosen) vs. surface as a
  distinct "stale" state.** Chosen: treat as `expired`/inactive, matching #3.
- **"Hash-chained integrity" (roadmap wording) — per-record content hash
  (chosen) vs. a linked chain.** Chosen: per-record, because a linked chain
  reintroduces the merge conflicts the format exists to prevent. Flagged so the
  reviewer can confirm the roadmap phrasing was aspirational, not a hard spec.
- **Who may `release` — anyone by id (chosen, with a note if the releaser isn't
  the holder) vs. only the holding agent.** Chosen: allow any releaser (advisory
  cleanup across the fleet is useful), but note a mismatch. A reviewer wanting
  stricter ownership can restrict it.
