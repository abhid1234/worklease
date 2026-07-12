// worklease — the append-only registry store.
//
// A registry is an append-only JSONL file (one JSON record per line). This
// module is the single home for the store: a small set of *pure* functions
// (canonical serialization, content-hash ids, log resolution) plus a thin I/O
// layer (`appendRecord`, `loadRegistry`) that keeps every filesystem access in
// one place. The design is deliberately lock-free — writes are single-line
// `O_APPEND` writes, reads fold the whole log into the current claim array, and
// every record self-identifies by a content hash, so concurrent or duplicated
// appends resolve cleanly instead of conflicting. Node's built-in `crypto` is
// the only "dependency"; there are zero runtime packages.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// --- pure core -------------------------------------------------------------

// canonicalize(record) → deterministic JSON string with sorted keys and no
// incidental whitespace, over the record EXCLUDING its own `id`. Recurses so
// key ordering can never perturb the digest at any depth. Used only as the hash
// pre-image, so it does not need to round-trip to a value.
export function canonicalize(record) {
  const { id: _id, ...rest } = record;
  return stableStringify(rest);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return (
      "{" +
      keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

// computeRecordId(record) → the sha256 content hash of the record (its `id`
// excluded). Deterministic and content-addressed: identical content ⇒ identical
// id, so a duplicated append is idempotent on read and a tampered line no longer
// matches its own id. `claim` (#2) uses this same helper so a claim's `id` IS its
// content hash — one shared implementation across every record type.
export function computeRecordId(record) {
  return createHash("sha256").update(canonicalize(record)).digest("hex");
}

// shortId(id) → first 8 hex chars, the compact id `list` shows and `release`
// accepts as a prefix.
export function shortId(id) {
  return typeof id === "string" ? id.slice(0, 8) : String(id);
}

// formatRelative(expires, now) → a short human relative expiry: "in 40s",
// "in 12m", "in 3h", or "expired" (also "unknown" for an unparseable value).
export function formatRelative(expires, now = Date.now()) {
  const ms = Date.parse(expires);
  if (Number.isNaN(ms)) return "unknown";
  const delta = ms - now;
  if (delta <= 0) return "expired";
  const s = Math.round(delta / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  return `in ${Math.round(m / 60)}h`;
}

// listActive(claims) → the subset whose effective status is "active". Pure
// selector kept here for direct unit testing.
export function listActive(claims) {
  return claims.filter((c) => c.status === "active");
}

// resolveRecords(records, { now }) → { claims, notes }
//
// Folds an already-parsed append log (order = append order) into the current
// claim array. Pure and total: `now` (epoch ms) is injected so expiry is
// deterministic, and no bad field value throws. Nothing is written back — every
// derived status is computed here at read time.
//
//   1. Integrity filter — drop any record whose `id` doesn't equal its own
//      content hash (tamper/corruption), with a note. One bad line never
//      discards the rest of the registry.
//   2. Fold claims — latest claim record per `id` wins (content-addressed, so
//      normally identical; tolerant of a re-append → idempotent).
//   3. Apply releases — a `release` record moves its `claim_id` to `released`;
//      an unknown `claim_id` is noted and ignored; a releaser who isn't the
//      holder is noted (advisory ownership hint).
//   4. Derive TTL expiry — an `active` claim whose `expires <= now` becomes
//      effective status `expired` (derived, with a note); released claims stay
//      released.
//
// Returns the claims sorted by `expires` ascending plus the collected notes.
export function resolveRecords(records, opts = {}) {
  const { now = Date.now() } = opts;
  const notes = [];

  // 1. Integrity filter (also drops non-objects, which can't self-hash).
  const valid = [];
  records.forEach((r, i) => {
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      notes.push(`skipped record ${i}: not an object`);
      return;
    }
    if (r.id !== computeRecordId(r)) {
      notes.push(`skipped record ${i}: id/content mismatch`);
      return;
    }
    valid.push(r);
  });

  // 2. Fold claims / collect releases (a record is a release iff type ===
  //    "release"; a claim iff no type or type === "claim"; anything else is
  //    forward-compat noise, skipped).
  const claims = new Map();
  const releases = [];
  for (const r of valid) {
    const type = r.type == null ? "claim" : r.type;
    if (type === "claim") {
      claims.set(r.id, { ...r });
    } else if (type === "release") {
      releases.push(r);
    } else {
      notes.push(`skipped record ${shortId(r.id)}: unknown type "${r.type}"`);
    }
  }

  // 3. Apply releases.
  for (const rel of releases) {
    const claim = claims.get(rel.claim_id);
    if (!claim) {
      notes.push(`release for unknown claim_id ${shortId(rel.claim_id)} ignored`);
      continue;
    }
    claim.status = "released";
    claim.released_by = rel.agent;
    claim.released_at = rel.at;
    if (rel.agent !== claim.agent) {
      notes.push(
        `claim ${shortId(claim.id)} released by ${rel.agent}, held by ${claim.agent}`
      );
    }
  }

  // 4. Derive TTL expiry (a claim exactly at expires === now counts as expired).
  for (const claim of claims.values()) {
    if (claim.status === "active" && claim.expires != null) {
      const exp = Date.parse(claim.expires);
      if (!Number.isNaN(exp) && exp <= now) {
        claim.status = "expired";
        notes.push(`claim ${shortId(claim.id)} expired at ${claim.expires}`);
      }
    }
  }

  const resolved = [...claims.values()].sort(byExpires);
  return { claims: resolved, notes };
}

// Sort by `expires` ascending; unparseable/absent expiries sort last, stably.
function byExpires(a, b) {
  const ea = Date.parse(a.expires);
  const eb = Date.parse(b.expires);
  const na = Number.isNaN(ea);
  const nb = Number.isNaN(eb);
  if (na && nb) return 0;
  if (na) return 1;
  if (nb) return -1;
  return ea - eb;
}

// --- I/O layer -------------------------------------------------------------

// defaultRegistryPath(cwd) → the ONE place the default registry location is
// defined; `check`, `list`, and `release` all call it. `WORKLEASE_REGISTRY`
// overrides, else a git-tracked `.worklease/registry.jsonl` at the repo root.
export function defaultRegistryPath(cwd = process.cwd()) {
  return process.env.WORKLEASE_REGISTRY || join(cwd, ".worklease", "registry.jsonl");
}

// appendRecord(path, record) → the stored record (with its content-hash `id`).
// Assigns `id` if absent, creates the parent directory, then appends exactly one
// JSON line terminated by "\n" with the `"a"` flag (O_APPEND). Existing lines are
// never rewritten — this is the whole safety story. Used by `release` here and by
// `claim` (#2).
export function appendRecord(path, record) {
  const stored = record.id ? record : { ...record, id: computeRecordId(record) };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(stored) + "\n");
  return stored;
}

// loadRegistry(path, { now }) → { claims, notes }
//
// Reads the JSONL file (missing file → empty registry, no throw), parses each
// non-blank line tolerantly (a line that won't parse is dropped with a note,
// never aborting the load), and returns the resolved current registry via
// `resolveRecords`. Replaces #3's interim reader.
export function loadRegistry(path, opts = {}) {
  const { now = Date.now() } = opts;

  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { claims: [], notes: [] };
    throw e;
  }

  const parsed = [];
  const parseNotes = [];
  raw.split("\n").forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      parsed.push(JSON.parse(trimmed));
    } catch {
      parseNotes.push(`skipped unparseable line ${i + 1}`);
    }
  });

  const resolved = resolveRecords(parsed, { now });
  return { claims: resolved.claims, notes: [...parseNotes, ...resolved.notes] };
}
