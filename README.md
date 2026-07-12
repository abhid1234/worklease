# worklease

**The open coordination format for fleets of AI coding agents.** Before an agent starts editing, it files a *claim* — "I intend to touch `src/auth/**` for the next 20 minutes" — to a shared, conflict-free registry. Other agents see it and steer clear. So parallel agents stop duplicating work and colliding on hotspot files. Zero dependencies.

> Working name — see [`vision.md`](vision.md). Grounded in the mid-2026 state of parallel agent coding.

Git worktrees are now the default for running many coding agents at once (Claude Code, Codex, Cursor) — but they only isolate the *filesystem*. Nothing warns you when two agents are about to edit the same code, so parallel runs still produce merge conflicts, duplicated features, and logic that compiles but disagrees at runtime. worklease is the missing coordination layer: a format for *intent*, not another orchestrator.

```bash
worklease claim "src/auth/**" --intent "add OAuth" --ttl 20m   # I'm taking this
worklease check "src/auth/login.ts"                            # is anyone else on it?
worklease list                                                  # who holds what, expiring when
worklease release <id>                                          # done
worklease conformance registry.jsonl merges.json               # did the fleet actually coordinate?
```

**Why it's different:** advisory, not a hard lock — it *warns and coordinates* so agents can pick different work. The registry is append-only JSONL with content-hash IDs, so it never merge-conflicts with itself even when many agents write at once. Harness-neutral: Claude Code, Codex, Cursor, or a factory worker.

Same open-format-and-conformance playbook as [opentrajectory](https://github.com/abhid1234/opentrajectory) and [constraintguard](https://github.com/abhid1234/constraintguard) — the coordination standard for the one thing a fleet can't currently share: *what it's about to touch.*

### `worklease claim <globs...>`

Files a claim — declares that you intend to edit the given globs, for a reason,
for a while — and **appends** it to the registry as one JSON line. This is the
write verb: `check` only ever reports clear until someone has claimed something.

```bash
worklease claim "src/auth/**" --intent "add OAuth" --ttl 20m --agent me
worklease claim "src/api/**" --intent "rate limits" --json    # print the claim object
```

- `--intent <str>` — **required**; why you're claiming (a claim without intent
  isn't useful — it's what lets another agent decide to wait or pick other work).
- `--ttl <dur>` — lease length: `<n>s`/`<n>m`/`<n>h` (e.g. `90s`, `20m`, `2h`) or a
  bare integer number of seconds. Default `30m`.
- `--agent <id>` (or `WORKLEASE_AGENT`) — who is filing; **required**.
- `--registry <path>` (or `WORKLEASE_REGISTRY`) — registry file location
  (default `.worklease/registry.jsonl`; the parent directory is created if
  missing).
- `--json` — print the created claim object instead of the human summary.

The written record is a fully-valid claim: `id` is the registry's deterministic
content hash of the record, and `expires` is `created + ttl`. The claim is
validated before it's written, so an unsupported glob is rejected rather than
appended. Exit `0` on write, `1` on any input or validation error.

The library also exports the pure `makeClaim(globs, meta)` constructor (no I/O,
no clock — `created` is passed in) for building claims programmatically.

### `worklease check <globs...>`

Asks whether your planned edit overlaps any **active** claim held by **another**
agent — the safe pre-edit question. Overlap is decided purely from the glob
strings (conservative *satisfiability*: any concrete path could match both), with
no filesystem access, so it is correct even for files that don't exist yet.

```bash
worklease check "src/auth/**"                 # human summary; exit 1 on conflict
worklease check "src/**/*.ts" --json          # { clear, conflicts: [...] } for harnesses
worklease check "src/auth/**" --agent me      # my own claims count as clear
```

- `--agent <id>` (or `WORKLEASE_AGENT`) — treat your own claims as clear.
- `--registry <path>` (or `WORKLEASE_REGISTRY`) — registry file location
  (default `.worklease/registry.jsonl`).
- `--json` — emit `{ clear, conflicts }` verbatim.
- Exit `0` when clear, `1` when any conflict — an advisory signal a pre-edit hook
  can gate on, not a hard lock.

### `worklease list`

Shows the active claims — who holds what, and when each lease expires — resolved
from the append log at read time (latest claim per id, releases applied, and
TTL-expired claims treated as inactive). One row each, sorted by soonest expiry.

```bash
worklease list                     # active claims: agent, globs, intent, expiry, id8
worklease list --all               # also released + expired, labeled
worklease list --agent me          # only my claims
worklease list --json              # the resolved claim array, for harnesses
```

- `--all` — include `released` and `expired` claims, each labeled with its
  effective status (default shows only `active`).
- `--agent <id>` — filter to a single holder.
- `--json` — emit the resolved claim array verbatim (each claim carries its
  effective `status`).
- `--registry <path>` (or `WORKLEASE_REGISTRY`) — registry file location.
- An empty or missing registry prints `no active claims` (`[]` under `--json`)
  and exits `0`.

### `worklease release <id>`

Drops a claim you're done with by **appending** a release record — it never edits
or deletes the original claim line, so a concurrent writer can't be lost.

```bash
worklease release fb964bcd                 # by short id (unambiguous prefix)
worklease release <full-id> --agent me     # record who released it
worklease release <id> --json              # print the appended release record
```

- Resolves the target by full `id` or an **unambiguous** id prefix (the short ids
  `list` prints work); an ambiguous prefix or an unknown id is an error (exit `1`).
- `--agent <id>` (or `WORKLEASE_AGENT`) — who is releasing; a release by someone
  other than the holder is allowed but noted (advisory cleanup across the fleet).
- Releasing an already-`released` or already-`expired` claim is a **no-op** with a
  note (still exit `0` — the desired end state already holds).
- `--registry <path>` (or `WORKLEASE_REGISTRY`) — registry file location.

### The registry

The store is an **append-only JSONL file** (default `.worklease/registry.jsonl`),
meant to be **committed** so it's shareable across worktrees and harnesses. New
records are appended as whole lines; existing lines are never rewritten. Every
record's `id` is a content hash of its own content, so a duplicated append is
idempotent on read and two agents appending at once union-merge cleanly instead
of conflicting. A line that fails its integrity check (or won't parse) is skipped
with a note — one bad line never discards the rest of the registry.

Dogfood target: the author's own parallel-agent software factory + Conductor sessions.

Status: **drafting** — see [`roadmap.md`](roadmap.md). MIT · zero dependencies · harness-neutral.
