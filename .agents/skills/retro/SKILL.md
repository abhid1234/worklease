---
name: retro
description: Analyze the factory's own run history for recurring failure and friction patterns, then propose concrete edits to the factory's skills as a pull request for human approval. Improves the factory; does not touch product code.
---

# Retro (self-improvement)

Runner: headless Claude Code on the mini. You are the factory improving itself —
the outer loop that studies the inner loops. Mine the factory's actual track
record, find where it under-performed, and propose specific, evidence-backed
edits to the skills so the same mistakes don't recur. Your changes go to a human
for approval, so be concrete and honest: propose a change only when the evidence
supports it. "The skills are performing well, no change needed" is a valid and
good outcome.

## Workflow

### 1. Gather the track record (GitHub is the durable history)
For the repo named in your prompt, use `gh` to read the factory's outcomes:
- All issues (`gh issue list --state all --limit 100 --json number,title,labels,state`) and, for the interesting ones, their full comment timelines.
- Merged and closed PRs (`gh pr list --state all --limit 50`).
Also read the recent factory log if available at `~/.hermes/logs/factory-tick.log`.

### 2. Look for these failure/friction signals
- **Triage errors** — an issue whose triage label was later changed by a human or downstream step (mis-classification), or a `/reject` on a spec that triage sent to `ready-to-spec`.
- **Spec rejections** — specs sent back with `/reject`; read the reason. A recurring reason means the spec skill has a blind spot.
- **Rework loops** — PRs with `Foundry rework attempt` comments; read the blocking defects. Defects that recur across issues mean the implementation skill (or the review skill) has a systematic gap.
- **Escalations** — `needs-human` issues; why did the loop fail to converge?
- **Review misses** — anything that passed review but caused a monitor-filed follow-up issue (the review should have caught it).
- **Monitor noise** — duplicate or out-of-scope issues the monitor filed (its dedup/scope judgment needs tightening).

### 3. Diagnose root causes, not symptoms
For each recurring pattern (ignore one-offs), name the specific skill at fault and
the exact instruction that's missing or wrong. Tie every proposal to concrete
evidence (issue/PR numbers, the actual defect or reason text).

### 4. Propose the edits as a PR
If — and only if — you found evidence-backed improvements:
- Create a branch `retro-<yyyy-mm-dd>` off `main`.
- Edit the relevant `.agents/skills/<name>/SKILL.md` file(s) with the smallest
  change that closes the gap (add/adjust a specific instruction). Keep each
  skill's voice and structure.
- Open a PR titled `Factory retro: skill improvements <date>` whose body lists,
  per proposed change: the pattern, the evidence (issue/PR refs), and the exact
  edit + why it prevents recurrence. End with `Retro for the factory` (do not
  reference an issue number to avoid auto-close). Do NOT merge — a human approves.

### 5. Report
As your final message, output a short summary: the patterns you found, what you
proposed (and the PR URL), and — separately — any HARNESS/process observations
that are NOT skill edits (e.g. tick timing, caps, flakiness) for the human to act
on directly. If you propose nothing, say so and give the evidence that the skills
are performing well.

## Guardrails
- Edit only `.agents/skills/**` — never product code, tests, or the tracker.
- Propose a change only with real evidence; do not invent problems to look busy.
- One cohesive retro PR; never merge it yourself.
- Separate skill edits (the PR) from harness/process notes (the report) — don't
  try to fix the harness by editing skills.
