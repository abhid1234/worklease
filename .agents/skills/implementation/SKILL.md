---
name: implementation
description: Implement a ready GitHub issue in this repo — fetch context, read specs if present, make the smallest cohesive change, validate it, open a pull request, and report progress on the issue.
---

# Implementation

Runner: headless Claude Code on the mini. Implement the issue named in the prompt and open a PR. Work in a fresh context against the issue + any spec; make the smallest change that satisfies it.

## Workflow

### 1. Start signal
Post a short `gh issue comment`: automated implementation has started + the issue number. Keep it concise.

### 2. Fetch context
Via `gh`: full issue title, body, comments, labels, linked issues. Look for links to specs or checked-in `specs/<issue>/PRODUCT.md` + `TECH.md`. If critical details are missing, post a concise blocker comment naming exactly what's missing and stop — do not guess.

### 3. Read specs first (if any)
If `PRODUCT.md` + `TECH.md` exist for the issue, read both fully and treat them as the source of truth for behavior, acceptance criteria, and non-goals. If they conflict with each other or the issue, stop and post a blocker comment.

### 4. Inspect the codebase
Read `roadmap.md` + `vision.md` and the affected area. Follow existing patterns and abstractions. Note the repo's validation commands (here: `npm test`).

### 5. Implement
Make the SMALLEST cohesive change that satisfies the issue. Follow existing style; update or add tests for the new behavior. Do NOT bundle unrelated refactors, formatting churn, dependency additions, or cleanup. If the issue turns out much larger/ambiguous than expected, stop and comment a concise recommendation instead of a risky partial.

When you add a new user-facing command or entry point, validate its inputs to the same standard as its best sibling — e.g. guard a required argument up front (as `add` does with `counter name required`) rather than letting a missing or blank value fall through to a confusing downstream error like `no such counter: undefined`. "Follow existing style" means matching the strongest sibling's validation and error UX, not copying whichever one is nearest; cover the missing/blank-argument path with a test.

### 6. Validate
Run `npm test` (and any lint/build). Fix failures caused by your change. If failures are unrelated/external, report them clearly. Do not call the work done until tests pass and a PR is open.

### 7. Open the PR + report
Create a branch, commit with a clear message referencing the issue (`Fixes #N`), push, and `gh pr create` with a body that summarizes the change, the validation run, and any spec references. Post a final `gh issue comment` with the PR URL. Move the issue to `in-review` (the caller applies the label).

## Guardrails
- One issue, one cohesive PR. No opportunistic scope.
- Never mark complete without an open PR URL and passing tests.
- No secrets or raw command dumps in comments.
- Zero new runtime dependencies unless the issue explicitly calls for it (tally is zero-dep on purpose).
