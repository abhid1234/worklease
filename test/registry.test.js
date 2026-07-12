import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalize,
  computeRecordId,
  resolveRecords,
  loadRegistry,
  appendRecord,
  defaultRegistryPath,
  listActive,
  formatRelative,
  shortId,
} from "../src/registry.js";

// A fixed clock so expiry is deterministic.
const NOW = Date.parse("2026-07-11T20:10:00Z");
const FUTURE = "2026-07-11T20:20:00Z"; // after NOW → active
const PAST = "2026-07-11T20:00:00Z"; // before NOW → expired

// Build a self-consistent claim record (id = its own content hash).
function claim(o) {
  const r = {
    agent: o.agent ?? "a1",
    globs: o.globs ?? ["src/**"],
    intent: o.intent ?? "work",
    ttl_seconds: o.ttl_seconds ?? 1200,
    created: o.created ?? "2026-07-11T20:00:00Z",
    expires: o.expires ?? FUTURE,
    status: o.status ?? "active",
  };
  return { id: computeRecordId(r), ...r };
}

function release(claimId, o = {}) {
  const r = {
    type: "release",
    claim_id: claimId,
    agent: o.agent ?? "a1",
    at: o.at ?? "2026-07-11T20:05:00Z",
  };
  return { id: computeRecordId(r), ...r };
}

// --- canonicalize / computeRecordId ---------------------------------------

test("computeRecordId is deterministic and key-order-independent", () => {
  const a = { agent: "a1", globs: ["x/**"], intent: "w" };
  const b = { intent: "w", globs: ["x/**"], agent: "a1" };
  assert.equal(computeRecordId(a), computeRecordId(b));
  assert.match(computeRecordId(a), /^[0-9a-f]{64}$/);
});

test("canonicalize excludes the id field", () => {
  const base = { agent: "a1", globs: ["x/**"] };
  assert.equal(canonicalize({ ...base, id: "anything" }), canonicalize(base));
});

test("changing any content field changes the id", () => {
  const base = computeRecordId({ agent: "a1", globs: ["x/**"], intent: "w" });
  assert.notEqual(computeRecordId({ agent: "a2", globs: ["x/**"], intent: "w" }), base);
  assert.notEqual(computeRecordId({ agent: "a1", globs: ["y/**"], intent: "w" }), base);
  assert.notEqual(computeRecordId({ agent: "a1", globs: ["x/**"], intent: "z" }), base);
});

test("shortId is the first 8 hex chars", () => {
  assert.equal(shortId("0123456789abcdef"), "01234567");
});

test("formatRelative renders seconds/minutes/hours and expired", () => {
  const now = Date.parse("2026-07-11T20:00:00Z");
  assert.equal(formatRelative("2026-07-11T20:00:40Z", now), "in 40s");
  assert.equal(formatRelative("2026-07-11T20:12:00Z", now), "in 12m");
  assert.equal(formatRelative("2026-07-11T22:00:00Z", now), "in 2h");
  assert.equal(formatRelative("2026-07-11T19:59:00Z", now), "expired");
  assert.equal(formatRelative("not-a-date", now), "unknown");
});

// --- resolveRecords --------------------------------------------------------

test("single active claim (now before expires) → one active claim", () => {
  const { claims, notes } = resolveRecords([claim({})], { now: NOW });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].status, "active");
  assert.equal(notes.length, 0);
  assert.equal(listActive(claims).length, 1);
});

test("a matching release moves the claim to released", () => {
  const c = claim({ agent: "a1" });
  const { claims } = resolveRecords([c, release(c.id)], { now: NOW });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].status, "released");
  assert.equal(claims[0].released_by, "a1");
  assert.equal(listActive(claims).length, 0);
});

test("an active claim past its TTL is derived to expired + a note (log unchanged)", () => {
  const c = claim({ expires: PAST });
  const { claims, notes } = resolveRecords([c], { now: NOW });
  assert.equal(claims[0].status, "expired");
  assert.ok(notes.some((n) => /expired/.test(n)));
  // The input record itself is not mutated.
  assert.equal(c.status, "active");
});

test("a claim exactly at expires === now counts as expired", () => {
  const c = claim({ expires: new Date(NOW).toISOString() });
  const { claims } = resolveRecords([c], { now: NOW });
  assert.equal(claims[0].status, "expired");
});

test("a duplicate claim record resolves to a single claim (idempotent)", () => {
  const c = claim({});
  const { claims } = resolveRecords([c, { ...c }], { now: NOW });
  assert.equal(claims.length, 1);
});

test("two distinct claims are both present, sorted by expires ascending", () => {
  const soon = claim({ globs: ["a/**"], expires: "2026-07-11T20:15:00Z" });
  const late = claim({ globs: ["b/**"], expires: "2026-07-11T20:25:00Z" });
  const { claims } = resolveRecords([late, soon], { now: NOW });
  assert.deepEqual(claims.map((c) => c.globs[0]), ["a/**", "b/**"]);
});

test("release for an unknown claim_id is ignored with a note", () => {
  const { claims, notes } = resolveRecords([release("nope")], { now: NOW });
  assert.equal(claims.length, 0);
  assert.ok(notes.some((n) => /unknown claim_id/.test(n)));
});

test("release by a different agent applies but is noted", () => {
  const c = claim({ agent: "a1" });
  const { claims, notes } = resolveRecords([c, release(c.id, { agent: "a2" })], { now: NOW });
  assert.equal(claims[0].status, "released");
  assert.ok(notes.some((n) => /released by a2, held by a1/.test(n)));
});

test("a record whose id doesn't match its content is skipped; the rest resolve", () => {
  const good = claim({ globs: ["good/**"] });
  const tampered = { ...claim({ globs: ["bad/**"] }), agent: "mutated" };
  const { claims, notes } = resolveRecords([good, tampered], { now: NOW });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].globs[0], "good/**");
  assert.ok(notes.some((n) => /id\/content mismatch/.test(n)));
});

test("a record with an unknown type is skipped with a note", () => {
  const weird = { type: "frobnicate", data: 1 };
  weird.id = computeRecordId(weird);
  const { claims, notes } = resolveRecords([weird], { now: NOW });
  assert.equal(claims.length, 0);
  assert.ok(notes.some((n) => /unknown type/.test(n)));
});

test("resolveRecords never throws on a malformed record", () => {
  assert.doesNotThrow(() =>
    resolveRecords([null, 42, "str", {}, { id: "x" }], { now: NOW })
  );
});

// --- appendRecord / loadRegistry ------------------------------------------

let dir;
test.before(() => {
  dir = mkdtempSync(join(tmpdir(), "worklease-reg-"));
});
test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("loadRegistry on a missing file → empty, no throw", () => {
  const res = loadRegistry(join(dir, "nope.jsonl"), { now: NOW });
  assert.deepEqual(res, { claims: [], notes: [] });
});

test("appendRecord assigns a content-hash id and returns the stored record", () => {
  const p = join(dir, "append-id.jsonl");
  const stored = appendRecord(p, { type: "release", claim_id: "abc", agent: "a1", at: "t" });
  assert.equal(stored.id, computeRecordId(stored));
});

test("two appends both survive; file has two \\n-terminated lines; first line unchanged", () => {
  const p = join(dir, "two-appends.jsonl");
  const a = appendRecord(p, claim({ globs: ["a/**"] }));
  const firstLineBefore = readFileSync(p, "utf8").split("\n")[0];
  const b = appendRecord(p, claim({ globs: ["b/**"] }));

  const raw = readFileSync(p, "utf8");
  const lines = raw.split("\n");
  assert.equal(lines[0], firstLineBefore, "append-only: first line is byte-identical");
  assert.equal(lines[2], "", "file ends in a trailing newline");
  assert.equal(raw.trim().split("\n").length, 2);

  const { claims } = loadRegistry(p, { now: NOW });
  assert.equal(claims.length, 2);
  assert.deepEqual(new Set(claims.map((c) => c.id)), new Set([a.id, b.id]));
});

test("a duplicate append is idempotent on read", () => {
  const p = join(dir, "dupe.jsonl");
  const c = claim({});
  appendRecord(p, c);
  appendRecord(p, c);
  const { claims } = loadRegistry(p, { now: NOW });
  assert.equal(claims.length, 1);
});

test("an unparseable line is skipped with a note; other lines still resolve", () => {
  const p = join(dir, "garbage.jsonl");
  appendRecord(p, claim({ globs: ["good/**"] }));
  writeFileSync(p, readFileSync(p, "utf8") + "{ not json\n");
  const { claims, notes } = loadRegistry(p, { now: NOW });
  assert.equal(claims.length, 1);
  assert.ok(notes.some((n) => /unparseable line/.test(n)));
});

test("appendRecord creates the parent directory when absent", () => {
  const p = join(dir, "nested", "deep", "registry.jsonl");
  appendRecord(p, claim({}));
  assert.equal(existsSync(p), true);
});

test("defaultRegistryPath honors WORKLEASE_REGISTRY, else .worklease/registry.jsonl", () => {
  const saved = process.env.WORKLEASE_REGISTRY;
  try {
    process.env.WORKLEASE_REGISTRY = "/tmp/custom.jsonl";
    assert.equal(defaultRegistryPath(), "/tmp/custom.jsonl");
    delete process.env.WORKLEASE_REGISTRY;
    assert.equal(defaultRegistryPath("/repo"), join("/repo", ".worklease", "registry.jsonl"));
  } finally {
    if (saved === undefined) delete process.env.WORKLEASE_REGISTRY;
    else process.env.WORKLEASE_REGISTRY = saved;
  }
});
