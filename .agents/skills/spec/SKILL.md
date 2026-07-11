---
name: spec
description: Write a product + technical spec for a ready-to-spec GitHub issue, open a spec pull request, and return a short summary for human review. Does not implement the change.
---

# Spec

Runner: headless Claude Code on the mini, invoked by the factory tick. Write a
product spec and a technical spec for the issue named in the prompt, open a
**spec pull request** (specs only — no product code), and return a concise
summary a human can approve from their phone.

The spec must be clear enough that the implementation agent can build the
change without asking the reporter basic questions — and honest about scope,
non-goals, and risk.

## Workflow

### 1. Fetch context
Use the `gh` CLI to read the full issue #N (title, body, comments, labels) and
related open issues. Read `roadmap.md` and `vision.md` at the repo root, then
inspect the codebase for the affected area. This is a spec, not an
implementation — do not edit product code.

### 2. Decide the direction
Where the issue has genuine ambiguity (multiple valid product or technical
approaches), pick the one that best fits the roadmap + vision and the existing
architecture, and say why. Name the alternatives you rejected in one line each.
If a real product decision genuinely can't be made from the available context,
write the spec around the recommended option but flag the open question clearly
for the human reviewer.

### 3. Write the specs
Create two files under `specs/issue-<N>/`:

**`PRODUCT.md`** — the what and why:
- Problem / motivation (1 short paragraph)
- Desired behavior (concrete, from the user's side)
- Acceptance criteria (a checklist the implementation must satisfy)
- Non-goals (what this explicitly does NOT do)
- Open questions (only if a real decision is unresolved)

**`TECH.md`** — the how:
- Approach (1 paragraph, the chosen design)
- Files / functions to touch (specific paths)
- Test plan (what tests prove it works; this repo uses `npm test`)
- Risks / edge cases / migrations
- Alternatives considered (one line each, why rejected)

Keep both tight and skimmable. Follow the repo's existing conventions (zero
dependencies for `tally`; small composable commands).

### 4. Open the spec PR
- Create a branch named exactly `spec-issue-<N>` off `main`.
- Commit only the `specs/issue-<N>/` files.
- Push and open a pull request with `gh pr create`:
  - Title: `Spec: <issue title>`
  - Body: a 3-6 line summary (the recommended direction, key acceptance
    criteria, any open question) followed by `Specs for #<N>` — use **"Specs
    for"**, NOT "Fixes", so the issue is not auto-closed.
- Do not merge it. A human reviews and approves the spec.

### 5. Return a summary
As your final message, output a short human-facing summary block (no JSON):
- One line: the recommended direction.
- 2-3 bullets: the key acceptance criteria.
- Any open question the reviewer should weigh in on.
- The spec PR URL.

## Guardrails
- Specs only in this PR — no product code, no test changes.
- Never merge the spec PR yourself; that is the human gate.
- No secrets or raw command dumps in comments.
- If critical information is missing to spec responsibly, post a concise
  blocker comment on the issue naming exactly what's needed, and stop.
