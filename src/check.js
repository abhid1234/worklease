// worklease — `check` core (pure orchestration over `globsOverlap`).
//
// Given planned-edit globs and a resolved registry array, report whether the
// plan overlaps any *active* claim held by *another* agent. No filesystem, no
// clock: time is injected as `opts.now` so expiry is deterministic in tests.

import { globsOverlap } from "./glob.js";

// check(plannedGlobs, registry, opts) → { clear, conflicts }
//
//   opts.agent — the caller's id; a claim by this agent counts as clear (you may
//                edit what you already hold). If null/undefined, no same-agent
//                filtering is applied (every active claim is treated as another
//                agent's — the safe default).
//   opts.now   — epoch ms used to evaluate `expires`; injected for determinism.
//
// A claim is a conflict iff ALL of: status === "active", its `expires` is still
// in the future, its `agent` differs from the caller, and at least one of its
// globs intersects a planned glob. Each conflict's `overlapping_globs` is the
// deduped, sorted subset of THAT claim's globs which overlap the plan.
export function check(plannedGlobs, registry, opts = {}) {
  const { agent = null, now = Date.now() } = opts;

  const conflicts = [];
  for (const claim of registry) {
    if (claim.status !== "active") continue;
    if (!(Date.parse(claim.expires) > now)) continue; // expired-by-time = clear
    if (agent != null && claim.agent === agent) continue; // own claim = clear

    const overlapping = claim.globs.filter((g) =>
      plannedGlobs.some((p) => globsOverlap(p, g))
    );
    if (overlapping.length) {
      conflicts.push({ claim, overlapping_globs: dedupeSort(overlapping) });
    }
  }

  return { clear: conflicts.length === 0, conflicts };
}

function dedupeSort(globs) {
  return [...new Set(globs)].sort();
}
