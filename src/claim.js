// worklease — `claim` core (pure claim constructor + ttl parsing).
//
// `makeClaim` builds a valid claim record with a deterministic content-hash id
// and a computed `expires`, with NO I/O and NO clock — `created` is injected via
// `meta`, so the result is fully determined by its inputs and unit-testable. The
// CLI (`bin/worklease.js`) is the only part that reads the clock and appends to
// the registry.

import { createHash } from "node:crypto";

// makeClaim(globs, meta) → a claim record matching #1's CLAIM_FIELDS order.
//
//   meta.agent       — who is filing the claim
//   meta.intent      — why (what work the globs are for)
//   meta.ttl_seconds — lease length in whole seconds (integer)
//   meta.created     — ISO-8601-UTC timestamp the claim is filed at
//
// `expires` is `created + ttl_seconds` to the millisecond, so #1's
// EXPIRES_MISMATCH cross-check holds by construction. `id` is a content hash of
// the identifying fields (agent, globs, intent, ttl_seconds, created); `status`
// is always "active" on creation. Pure and total: it does not throw and does no
// validation — the CLI validates the finished record via #1's `validateClaim`.
export function makeClaim(globs, meta = {}) {
  const { agent, intent, ttl_seconds, created } = meta;
  const expires = isoAddSeconds(created, ttl_seconds);
  const id = claimId({ agent, globs, intent, ttl_seconds, created });
  return {
    id,
    agent,
    globs,
    intent,
    ttl_seconds,
    created,
    expires,
    status: "active",
  };
}

// parseTtl(input) → integer seconds, or null on anything invalid.
//
// Accepts a compact duration shorthand (`<n>s`, `<n>m`, `<n>h`) or a bare
// positive integer interpreted as seconds (string or number). A bad unit, a
// non-integer, zero, a negative, or empty input returns null (never throws) so
// the caller can print one clear error and exit.
export function parseTtl(input) {
  if (typeof input === "number") {
    return Number.isInteger(input) && input > 0 ? input : null;
  }
  if (typeof input !== "string") return null;

  const s = input.trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 0 ? n : null; // bare seconds; "0" → null
  }

  const m = /^(\d+)(s|m|h)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (n <= 0) return null; // "0m" → null
  const mult = { s: 1, m: 60, h: 3600 }[m[2]];
  return n * mult;
}

// created + ttl_seconds as an ISO-8601-UTC string. With whole-second `created`
// and integer `ttl_seconds`, epoch-ms equality with #1's derived value holds.
function isoAddSeconds(created, ttl_seconds) {
  return new Date(Date.parse(created) + ttl_seconds * 1000).toISOString();
}

// Deterministic content hash of the identifying fields. Hashes a fixed-order
// JSON array (not the object) so key ordering can never perturb the digest;
// `expires` (derived) and `status` (lifecycle) are intentionally excluded.
// SHA-256 via Node's built-in crypto, truncated to 16 hex chars.
function claimId({ agent, globs, intent, ttl_seconds, created }) {
  const canonical = JSON.stringify([agent, globs, intent, ttl_seconds, created]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
