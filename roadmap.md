# worklease — roadmap

Built the same way as constraintguard / memport / selfpatch: each feature is one GitHub issue → triaged → specced → implemented → adversarially reviewed → shipped, with a human at the gates. Zero dependencies; harness-neutral; git-backed.

## Design principles
1. **Advisory, not enforcing.** worklease warns and coordinates; it never hard-locks. Enforcement is the harness's choice.
2. **The registry never conflicts with itself.** Append-only JSONL with content-hash IDs, so two agents writing claims at once can't corrupt or merge-conflict the registry.
3. **Intent is first-class.** A claim carries *what* (globs) and *why* (intent) and *how long* (ttl) — so another agent can decide to wait, pick different work, or coordinate.
4. **Zero-dep, harness-neutral.** Works for Claude Code, Codex, Cursor, or a factory worker — anything that can run a CLI or import a function.

## Core (v0.1)

1. **schema** — `validateClaim` / `validateRegistry`. The open shape of a claim: `{ id, agent, globs[], intent, ttl_seconds, created, expires, status: "active"|"released"|"expired" }`. Foundation. *(mirrors the other repos' #1)*

2. **claim** — `worklease claim <globs...> --intent "..." --ttl 20m`. Appends a validated claim to the registry with a content-hash id and computed expiry. Deterministic; pure core with I/O injected.

3. **check** — `worklease check <globs...>`. The heart: does a planned edit overlap any *active* claim by another agent? Returns `{ clear, conflicts: [{claim, overlapping_globs}] }`. Glob-intersection logic (does `src/auth/**` overlap `src/**/*.ts`?) is the crux — pure, well-tested, zero-dep.

4. **registry** — `worklease list` / `release <id>` / the append-only JSONL store with hash-chained integrity and TTL-based expiry. Two agents appending at once must never corrupt it or lose a claim.

5. **conformance** — `worklease conformance <registry> <merges>`. After the fact: did each merged change fall within a claim the merging agent held, and did anyone edit files under another agent's *active* claim? Returns a coordination score + the violations. The "did the fleet actually coordinate?" metric.

## Adapters & ecosystem (v0.2)

6. **git-hook adapter (dogfood)** — a pre-edit / pre-commit hook bundle that auto-`check`s before an agent writes, and warns on overlap. Dogfood on the author's own parallel-agent factory + Conductor sessions.
7. **Claude Code / Codex / Cursor adapters** — surface claims to each harness (e.g. an MCP tool or a hook) so agents `check` before starting and `claim` as they go.
8. **`worklease watch`** — a live view of active claims across the fleet (who's holding what, expiring when).
9. **OpenTelemetry bridge** — emit claim/conflict events as span attributes (reuse the family pattern).

## The playground (community hook — priority)
A browser page running the **real** library: two simulated agents pick tasks in a repo with a shared hotspot file. Toggle worklease **off** → watch them both edit `config.js` and collide (a merge conflict + duplicated work). Toggle **on** → agent B's `check` sees agent A's live claim, picks different work, and the collision never happens — with a live registry view. Same house style as constraintguard.vercel.app. This is the visceral "watch the collision get prevented" demo.

## Launch (v0.1 public)
Public repo + green CI + MIT + npm (`@avee1234/worklease`) + the playground + a research-grounded README (the worktrees-solved-the-wrong-half framing). Then the video/posts kit. Narrative: *parallel agents are the norm now; worktrees isolate the filesystem but nothing coordinates intent; here's the open, zero-dep layer that lets a fleet share what it's about to touch — before the collision.*

## Open design questions (for the human gate)
- **glob-overlap semantics** — exact glob intersection, or path-prefix + pattern match? How to treat `**` vs a concrete file. Leaning: a small, well-tested glob-intersection core.
- **claim granularity** — file globs only, or also symbol/function-level claims? Leaning: globs for v0.1, symbol-level later.
- **registry location** — a tracked git file (survives, shareable) vs an ignored local file vs a tiny broker process? Leaning: a git-tracked append-only JSONL for v0.1 (conflict-free by construction).
- **TTL default + expiry** — what's a sane default lease, and does `check` treat an expired-but-unreleased claim as clear? Leaning: default 30m, expired = clear (with a warning).
- **first dogfood surface** — a git pre-commit hook (broad) vs a Claude Code hook (closest to home). Leaning: Claude Code hook, since the author's fleet runs there.
