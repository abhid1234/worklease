// worklease — `conformance` core (pure orchestration over `globsOverlap`).
//
// The after-the-fact metric: given a resolved registry and a set of *merges*
// (the files each agent actually touched), score whether the fleet coordinated.
// For each `(agent, file)` change it asks two questions — did the acting agent
// hold a claim covering the file, and did the file fall under a *different*
// agent's live claim? — and partitions every change into exactly one of
// {respected, violation, warning}. No filesystem, no clock: all time comparisons
// use the merge record's own `at` (or fall back to claim `status`), so the core
// is pure and deterministic.
//
// A touched file is a concrete (wildcard-free) glob, so "does file F fall under
// claim glob G?" is exactly `globsOverlap(F, G)` from #3 — no new matching logic.

import { globsOverlap } from "./glob.js";
import { isIso8601Utc } from "./schema.js";

// Is claim `c` held/active at instant `at` (ISO string)? Temporal window
// [created, expires): created ≤ at < expires. A release ends a claim, so when
// `released_at` is a valid timestamp the window closes early: also require
// at < released_at (half-open, matching `expires` — a change exactly at
// `released_at` is not held). Malformed timestamps are treated as "not
// held/active" (conservative — never invents coverage or a violation): a
// present-but-invalid `released_at` marks a release we cannot place, so the
// claim is not held (it does not fall back to the [created, expires) window).
function within(c, at) {
  if (!isIso8601Utc(at) || !isIso8601Utc(c.created) || !isIso8601Utc(c.expires)) {
    return false;
  }
  const t = Date.parse(at);
  if (Date.parse(c.created) > t || t >= Date.parse(c.expires)) {
    return false;
  }
  if (c.released_at == null) return true; // never released
  return isIso8601Utc(c.released_at) && t < Date.parse(c.released_at);
}

// Status fallback for coverage when a change has no `at`: any non-expired claim.
function notExpired(c) {
  return c.status !== "expired";
}

// conformance(claims, merges, opts) → { score, total, respected, violations, warnings }
//
//   claims  — resolved registry array (latest record per id), each claim
//             `{ id, agent, globs[], intent, ttl_seconds, created, expires, status }`.
//   merges  — array of `{ agent, files: string[], at? }`; flattened to one change
//             per `(agent, file)`.
//   opts    — reserved; no clock needed (this is an after-the-fact audit).
//
// A change by agent A on file F at time T is:
//   - covered   — A held a matching claim at T (temporal `within` if `at`,
//                 else non-expired status).
//   - violation — a DIFFERENT agent B held a matching claim live at T (temporal
//                 if `at`, else `status === "active"`); one entry per such claim.
//   - respected — covered ∧ not a violation (the coordination numerator).
//   - warning   — uncovered ∧ not a violation (edited an unclaimed file).
// A colliding change is a violation even if A also held a claim (double-claim).
export function conformance(claims, merges, opts = {}) {
  const changes = merges.flatMap((m) =>
    m.files.map((file) => ({ agent: m.agent, file, at: m.at }))
  );

  const violations = [];
  const warnings = [];
  let respected = 0;

  for (const { agent, file, at } of changes) {
    const matching = claims.filter((c) => c.globs.some((g) => globsOverlap(file, g)));

    const held = (c) => (at != null ? within(c, at) : notExpired(c));
    const live = (c) => (at != null ? within(c, at) : c.status === "active");

    const covered = matching.some((c) => c.agent === agent && held(c));
    const colliding = matching.filter((c) => c.agent !== agent && live(c));

    if (colliding.length) {
      for (const c of colliding) {
        violations.push({ agent, file, conflicting_claim: c });
      }
    } else if (covered) {
      respected += 1;
    } else {
      warnings.push({ agent, file });
    }
  }

  const total = changes.length;
  const score = total === 0 ? 1 : respected / total;
  return { score, total, respected, violations, warnings };
}
