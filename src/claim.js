// worklease — `claim` core (pure claim constructor + ttl parsing).
//
// `makeClaim` builds a valid claim record with a deterministic content-hash id
// and a computed `expires`, with NO I/O and NO clock — `created` is injected via
// `meta`, so the result is fully determined by its inputs and unit-testable. The
// CLI (`bin/worklease.js`) is the only part that reads the clock and appends to
// the registry.

import { computeRecordId } from "./registry.js";

// makeClaim(globs, meta) → a claim record matching #1's CLAIM_FIELDS order.
//
//   meta.agent       — who is filing the claim
//   meta.intent      — why (what work the globs are for)
//   meta.ttl_seconds — lease length in whole seconds (integer)
//   meta.created     — ISO-8601-UTC timestamp the claim is filed at
//
// `expires` is `created + ttl_seconds` to the millisecond, so #1's
// EXPIRES_MISMATCH cross-check holds by construction. `id` is the registry's
// shared content hash of the whole record (its `id` excluded), so a claim's id
// IS its content hash and it resolves cleanly through #4's store — one hasher
// across every record type. `status` is always "active" on creation. Pure and
// total: it does not throw and does no validation — the CLI validates the
// finished record via #1's `validateClaim`.
export function makeClaim(globs, meta = {}) {
  const { agent, intent, ttl_seconds, created } = meta;
  const expires = isoAddSeconds(created, ttl_seconds);
  const record = {
    agent,
    globs,
    intent,
    ttl_seconds,
    created,
    expires,
    status: "active",
  };
  return { id: computeRecordId(record), ...record };
}

// parseTtl(input) → integer seconds, or null on anything invalid.
//
// Accepts a compact duration shorthand (`<n>s`, `<n>m`, `<n>h`) or a bare
// positive integer interpreted as seconds (string or number). A bad unit, a
// non-integer, zero, a negative, or empty input returns null (never throws) so
// the caller can print one clear error and exit.
export function parseTtl(input) {
  // Guard against values that survive `> 0` but overflow later date math: a huge
  // digit string parses to a non-safe integer (or Infinity), which would make
  // `expires` an out-of-range Date. Require a SAFE integer everywhere.
  if (typeof input === "number") {
    return Number.isSafeInteger(input) && input > 0 ? input : null;
  }
  if (typeof input !== "string") return null;

  const s = input.trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isSafeInteger(n) && n > 0 ? n : null; // bare seconds; "0" → null
  }

  const m = /^(\d+)(s|m|h)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n <= 0) return null; // "0m" → null
  const mult = { s: 1, m: 60, h: 3600 }[m[2]];
  const total = n * mult;
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

// created + ttl_seconds as an ISO-8601-UTC string. With whole-second `created`
// and integer `ttl_seconds`, epoch-ms equality with #1's derived value holds.
function isoAddSeconds(created, ttl_seconds) {
  // Total, never-throwing: an unparseable `created`, a non-safe `ttl_seconds`,
  // or a sum beyond the Date range (±8.64e15 ms) yields "" so the record fails
  // validateClaim's INVALID_ISO8601 check and the CLI rejects it predictably —
  // rather than makeClaim throwing a RangeError from toISOString().
  const base = Date.parse(created);
  if (Number.isNaN(base) || !Number.isSafeInteger(ttl_seconds)) return "";
  const ms = base + ttl_seconds * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "";
  return new Date(ms).toISOString();
}
