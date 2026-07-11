import { test } from "node:test";
import assert from "node:assert/strict";
import { check } from "../src/check.js";

// Fixed clock so expiry is deterministic.
const NOW = Date.parse("2026-01-01T00:00:00Z");
const FUTURE = "2026-01-01T01:00:00Z"; // after NOW
const PAST = "2025-12-31T23:00:00Z"; // before NOW

function claim(overrides = {}) {
  return {
    id: "id-default",
    agent: "other",
    globs: ["src/auth/**"],
    intent: "refactor auth",
    expires: FUTURE,
    status: "active",
    ...overrides,
  };
}

test("empty registry → clear", () => {
  assert.deepEqual(check(["src/auth/login.ts"], [], { now: NOW }), {
    clear: true,
    conflicts: [],
  });
});

test("active other-agent overlapping claim → one conflict", () => {
  const c = claim();
  const res = check(["src/**/*.ts"], [c], { agent: "me", now: NOW });
  assert.equal(res.clear, false);
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].claim, c);
  assert.deepEqual(res.conflicts[0].overlapping_globs, ["src/auth/**"]);
});

test("non-overlapping active claim → clear", () => {
  const res = check(["src/api/**"], [claim()], { agent: "me", now: NOW });
  assert.deepEqual(res, { clear: true, conflicts: [] });
});

test("same-agent claim is treated as clear", () => {
  const res = check(["src/auth/x.ts"], [claim({ agent: "me" })], {
    agent: "me",
    now: NOW,
  });
  assert.deepEqual(res, { clear: true, conflicts: [] });
});

test("agent omitted → every active claim is another agent's", () => {
  const res = check(["src/auth/x.ts"], [claim({ agent: "me" })], { now: NOW });
  assert.equal(res.clear, false);
  assert.equal(res.conflicts.length, 1);
});

test("released and expired-by-status claims are ignored", () => {
  const reg = [
    claim({ id: "r", status: "released" }),
    claim({ id: "e", status: "expired" }),
  ];
  assert.deepEqual(check(["src/auth/x.ts"], reg, { now: NOW }), {
    clear: true,
    conflicts: [],
  });
});

test("expired-by-time claim (expires <= now) is ignored", () => {
  const reg = [claim({ id: "old", expires: PAST })];
  assert.deepEqual(check(["src/auth/x.ts"], reg, { now: NOW }), {
    clear: true,
    conflicts: [],
  });
});

test("expires exactly at now is not in the future → ignored", () => {
  const reg = [claim({ expires: "2026-01-01T00:00:00Z" })];
  assert.deepEqual(check(["src/auth/x.ts"], reg, { now: NOW }), {
    clear: true,
    conflicts: [],
  });
});

test("overlap via any one of multiple planned globs → conflict", () => {
  const res = check(["docs/**", "src/auth/**"], [claim()], { now: NOW });
  assert.equal(res.clear, false);
  assert.equal(res.conflicts.length, 1);
});

test("only the overlapping subset of a claim's globs is reported, deduped + sorted", () => {
  const c = claim({
    globs: ["src/auth/**", "src/api/**", "src/auth/login.ts", "docs/z.md"],
  });
  const res = check(["src/auth/**"], [c], { now: NOW });
  assert.equal(res.clear, false);
  assert.deepEqual(res.conflicts[0].overlapping_globs, [
    "src/auth/**",
    "src/auth/login.ts",
  ]);
});

test("clear iff conflicts empty; multiple conflicting claims all reported", () => {
  const reg = [
    claim({ id: "a", agent: "x", globs: ["src/auth/**"] }),
    claim({ id: "b", agent: "y", globs: ["src/**/*.ts"] }),
    claim({ id: "c", agent: "z", globs: ["docs/**"] }),
  ];
  const res = check(["src/auth/login.ts"], reg, { now: NOW });
  assert.equal(res.clear, false);
  assert.deepEqual(
    res.conflicts.map((c) => c.claim.id).sort(),
    ["a", "b"]
  );
});
