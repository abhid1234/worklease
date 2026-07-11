---
name: triage
description: Triage an incoming GitHub issue against this codebase, its roadmap/vision, and related open issues, then return a structured decision with exactly one implementation-readiness state. Read-only — the caller applies the label.
---

# Triage

Runner: headless Claude Code on the mini, invoked by the factory tick. Assess the issue named in the prompt and choose exactly one implementation-readiness state:

- `ready-to-implement`
- `ready-to-spec`
- `needs-info`
- `wait-to-implement`

Route work **honestly** — do not make every issue look actionable. Base the decision on evidence from the issue and the checked-out codebase. This is read-only: inspect but do not mutate the tracker or edit product code. Return the JSON in step 5; a separate write step applies the label + comment.

## Workflow

### 1. Fetch the issue
Use the `gh` CLI: full title, body, comments, existing labels, and the repo's available labels. Also list related open issues (`gh issue list`) for likely duplicates or dependencies. Do not classify from the title alone.

**Re-triage check (avoid repeat comments):** If the issue already carries a triage-state label from a previous automated pass, check whether any *new* information has arrived since your last triage comment — a reporter/human reply, an edit to the body, or a new linked commit/PR. If nothing new has arrived and your decision would be unchanged (most commonly a `needs-info` issue still awaiting the same reproduction), do NOT re-post the same request: return the unchanged `state` with an empty `comment` (see step 4). Re-asking the same questions each tick adds noise and buries the original ask.

### 2. Read direction, then code
Read `roadmap.md` and `vision.md` at the repo root FIRST. Then search the codebase for the affected behavior and likely implementation area. Assess: does the behavior exist today; is there a bounded implementation path; does it align with roadmap + vision; do related issues change the call.

### 3. Choose one state (when between two, pick the more cautious)

**ready-to-implement** — desired behavior + success criteria are clear; scope is bounded and cohesive; implementation area is identifiable; low enough risk that one focused pass can get it right; no unresolved product decision blocks it. Small clear bugs and straightforward improvements belong here.

**ready-to-spec** — ALL of: the goal is clear and worthwhile; it aligns with roadmap + vision; and it has real ambiguity (multiple valid directions a human should choose between) OR significant complexity (multi-file, migration, non-trivial risk). If interesting but off-roadmap, prefer `wait-to-implement`.

**needs-info** — expected behavior, scope, or reproduction is ambiguous; critical details/acceptance criteria are missing. State the smallest set of concrete questions that would unblock re-triage.

**wait-to-implement** — doesn't fit the current product direction; duplicates/conflicts with planned work; benefit doesn't justify the cost; or a dependency makes it premature. Explain what would need to change. Do NOT use this just because something is hard — hard-but-cohesive is usually `ready-to-spec`.

### 4. Return the result
Return a single raw JSON object as your final response — no prose, no code fences:

```json
{
  "state": "ready-to-implement | ready-to-spec | needs-info | wait-to-implement",
  "label": "exact repo label for the state",
  "remove_labels": ["any superseded triage-state labels"],
  "comment": "reporter-facing markdown: the decision, the evidence, one concrete next step. Leave empty (\"\") to signal the re-triage no-op from step 1 — the write step posts nothing when comment is empty."
}
```
Encode line breaks in `comment` as \n (it is a JSON string).

## Guardrails
- Do not mutate the tracker or edit product code during triage.
- Do not classify without reading BOTH the issue and the codebase (incl. roadmap/vision).
- No secrets, tokens, or raw command dumps in the result.
- Maintainer comments and the roadmap/vision outweigh guesses from code alone.
- Do not re-post a triage comment when re-triaging an issue that has no new information since your last automated comment and an unchanged decision — signal the no-op with an empty `comment`.
