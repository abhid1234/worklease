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

The written record is a fully-valid claim: `id` is a deterministic content hash
of the claim's identifying fields, and `expires` is `created + ttl`. The claim is
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

### `worklease conformance <registry> <merges>`

Scores, **after the fact**, whether the fleet actually coordinated. `claim`/`check`
coordinate *before* the edit; `conformance` closes the loop: given the registry and
a **merges** file (the files each agent actually touched), it reports how well the
merges respected the claims.

```bash
worklease conformance registry.jsonl merges.json          # human summary; exit 1 on any violation
worklease conformance registry.jsonl merges.json --json   # { score, total, respected, violations, warnings }
```

The merges file is a JSON array (or JSONL, one record per line) of
`{ agent, files: ["path", …], at? }` — `agent` is who made the change, `files` are
the concrete paths they touched, and the optional `at` (ISO-8601-UTC) is when the
change landed. Each `(agent, file)` pair is one **change**, classified as exactly one of:

- **respected** — the acting agent held a matching claim *and* the file wasn't under
  another agent's live claim. These are the coordination numerator.
- **violation** — the file fell under a **different** agent's claim that was active at
  the change time (`created ≤ at < expires`; falls back to claim `status === "active"`
  when a record has no `at`). One entry per conflicting claim, with the full claim record.
- **warning** — the agent held no matching claim and nobody else did either: an edit to
  an *unclaimed* file. It lowers the score but is not a collision.

`score` is `respected / total` (a float in `[0, 1]`, `1` when there are no changes). So a
fleet that never claims anything scores `0` — the score rewards coverage, not just the
absence of collisions. Overlap reuses the same glob core as `check`. Exit `0` when there
are **no violations**, `1` otherwise; a low score from warnings alone is advisory and does
not fail. Missing registry or merges files are treated as empty inputs.

The library also exports the pure `conformance(claims, merges, opts)` core (no I/O, no
clock — time comes from each merge's `at`) for scoring programmatically.

Dogfood target: the author's own parallel-agent software factory + Conductor sessions.

Status: **drafting** — see [`roadmap.md`](roadmap.md). MIT · zero dependencies · harness-neutral.
