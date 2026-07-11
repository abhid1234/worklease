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

Dogfood target: the author's own parallel-agent software factory + Conductor sessions.

Status: **drafting** — see [`roadmap.md`](roadmap.md). MIT · zero dependencies · harness-neutral.
