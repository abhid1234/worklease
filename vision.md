# worklease — vision

*(working name; alts: fleetclaim, claimspace. Renameable — everything is scoped `@avee1234/worklease`.)*

## The one-liner
**The open coordination format for fleets of AI coding agents.** Before an agent starts editing, it files a *claim* — "I intend to touch `src/auth/**` for the next 20 minutes" — to a shared, conflict-free registry. Other agents see it and steer clear. So parallel agents stop duplicating work and colliding on hotspot files.

## The problem (verified, mid-2026)
Running many coding agents in parallel is now standard — Claude Code, Codex, and Cursor all default to **git worktrees** for it. But worktrees solved the *wrong half* of the problem. They isolate the **filesystem**; they do nothing about **coordination**:

> "The worktrees are separate, so you can create merge conflicts between them without knowing, and **no tool warns you when two agents might edit the same code.**"

Real repos have **hotspot files** — routes, configs, registries, a shared dispatch file — where parallel agents predictably collide, producing merge-conflict time, **duplicated features**, and "logic that compiles but disagrees at runtime." Even Anthropic's own 16-agent C-compiler run hit duplicate work and merge conflicts. As the number of concurrent agents grows, uncoordinated parallel writes get expensive fast.

The fix everyone gestures at is the same — *an agent declares intent to edit specific file globs for a TTL, and others see the reservation and coordinate* — but today it's **ad-hoc and per-tool.** There's no open, vendor-neutral standard, so a Claude Code agent and a Codex agent and a factory worker in the same repo can't see each other's intentions at all.

## The wedge — a coordination format, not an orchestrator
worklease is **not** an orchestrator (Conductor, Warp, and factory harnesses own that) and **not** worktree isolation (git owns that). It's the thin open layer *between* parallel agents:

- an open JSON schema for a **claim** — `{ id, agent, globs[], intent, ttl, created, status }`
- a **conflict-free, git-backed registry** (append-only JSONL with hash IDs, so the registry itself never merge-conflicts)
- the verbs any harness can call: **`claim`** (declare intent), **`check`** (does my intended work overlap a live claim?), **`release`** (drop it), **`conformance`** (did the merges actually respect the claims?)
- advisory by design — it *warns and coordinates*, it doesn't hard-lock. Zero dependencies, harness-neutral.

This is the exact playbook behind [opentrajectory](https://github.com/abhid1234/opentrajectory) (traces), [constraintguard](https://github.com/abhid1234/constraintguard) (constraints), memport (memory), and selfpatch (self-modification): **own the open interoperability standard, not the runtime.** worklease is that standard for the one thing the fleet can't currently share — *intent*.

## Why it's defensible
- **Neutral by construction** — no single agent vendor will build the protocol that lets a *rival's* agent coordinate with theirs; a third party is the natural home for the standard.
- **Complements worktrees + MCP** — worktrees give isolation, MCP gives tools; worklease gives shared intent. A claim is what an agent publishes *before* it opens its worktree.
- **Small, verifiable surface** — a schema + a git-backed registry + a conformance check. The same shape the factory builds and adversarially reviews well.

## The unfair advantage
The author lives this problem daily: a parallel-agent software factory, Conductor for parallel Claude Codes, and multiple background drivers that already step around each other. worklease's first user, testbed, and demo is the author's own fleet.

## What "done for v0.1" looks like
A `worklease` CLI + zero-dep library that lets an agent claim a set of globs with an intent and TTL, check whether a planned edit overlaps a live claim before starting, release when done, and score after the fact whether a set of merges respected the claims — backed by a registry that never conflicts with itself, with a live playground where you watch two agents *avoid* a collision they'd otherwise have.

## Non-goals
- Not an orchestrator or a scheduler (it informs orchestrators; it doesn't assign work).
- Not a hard lock / mutex service (advisory intent, not enforcement — enforcement is the harness's choice).
- Not merge-conflict resolution (git owns that) — worklease exists to *prevent* the collision upstream, not to resolve it after.
