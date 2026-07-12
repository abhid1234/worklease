import { test } from "node:test";
import assert from "node:assert/strict";
import { conformance } from "../src/conformance.js";

// A time window used for the temporal (`at`-based) cases.
const CREATED = "2026-01-01T00:00:00Z";
const EXPIRES = "2026-01-01T01:00:00Z";
const INSIDE = "2026-01-01T00:30:00Z"; // created ≤ INSIDE < expires
const BEFORE = "2025-12-31T23:30:00Z"; // before created
const AFTER = "2026-01-01T02:00:00Z"; // at/after expires

function claim(overrides = {}) {
  return {
    id: "c-default",
    agent: "A",
    globs: ["src/auth/**"],
    intent: "auth work",
    ttl_seconds: 3600,
    created: CREATED,
    expires: EXPIRES,
    status: "active",
    ...overrides,
  };
}

test("empty merges → score 1, totals 0, empty lists", () => {
  assert.deepEqual(conformance([claim()], []), {
    score: 1,
    total: 0,
    respected: 0,
    violations: [],
    warnings: [],
  });
});

test("empty registry, some changes → all warnings, score 0", () => {
  const merges = [{ agent: "A", files: ["src/auth/login.ts", "docs/README.md"] }];
  const res = conformance([], merges);
  assert.equal(res.total, 2);
  assert.equal(res.respected, 0);
  assert.equal(res.score, 0);
  assert.equal(res.violations.length, 0);
  assert.equal(res.warnings.length, 2);
});

test("change covered by the agent's own held claim → respected, no lists", () => {
  const merges = [{ agent: "A", files: ["src/auth/login.ts"], at: INSIDE }];
  const res = conformance([claim()], merges);
  assert.deepEqual(res, {
    score: 1,
    total: 1,
    respected: 1,
    violations: [],
    warnings: [],
  });
});

test("change under a different agent's live claim → one violation, not respected", () => {
  const c = claim({ agent: "B" });
  const merges = [{ agent: "A", files: ["src/auth/login.ts"], at: INSIDE }];
  const res = conformance([c], merges);
  assert.equal(res.respected, 0);
  assert.equal(res.score, 0);
  assert.equal(res.warnings.length, 0);
  assert.equal(res.violations.length, 1);
  assert.deepEqual(res.violations[0], {
    agent: "A",
    file: "src/auth/login.ts",
    conflicting_claim: c,
  });
});

test("double claim (own + other's live claim) → violation, not respected", () => {
  const own = claim({ id: "own", agent: "A" });
  const other = claim({ id: "other", agent: "B" });
  const merges = [{ agent: "A", files: ["src/auth/login.ts"], at: INSIDE }];
  const res = conformance([own, other], merges);
  assert.equal(res.respected, 0);
  assert.equal(res.violations.length, 1);
  assert.equal(res.violations[0].conflicting_claim, other);
});

test("file matched by no claim → warning, not violation", () => {
  const merges = [{ agent: "A", files: ["docs/README.md"], at: INSIDE }];
  const res = conformance([claim()], merges);
  assert.equal(res.violations.length, 0);
  assert.deepEqual(res.warnings, [{ agent: "A", file: "docs/README.md" }]);
  assert.equal(res.respected, 0);
});

test("at-window boundaries: created is active, expires is not", () => {
  const merges = [
    { agent: "A", files: ["src/auth/a.ts"], at: CREATED }, // T === created → held
    { agent: "A", files: ["src/auth/b.ts"], at: EXPIRES }, // T === expires → not held
    { agent: "A", files: ["src/auth/c.ts"], at: BEFORE }, // before → not held
    { agent: "A", files: ["src/auth/d.ts"], at: AFTER }, // after → not held
  ];
  const res = conformance([claim()], merges);
  assert.equal(res.respected, 1); // only the T === created change is covered
  assert.equal(res.warnings.length, 3);
  assert.equal(res.violations.length, 0);
});

test("status fallback (no at): coverage uses non-expired own claim", () => {
  const merges = [{ agent: "A", files: ["src/auth/login.ts"] }]; // no `at`
  assert.equal(conformance([claim({ status: "active" })], merges).respected, 1);
  assert.equal(conformance([claim({ status: "released" })], merges).respected, 1);
  assert.equal(conformance([claim({ status: "expired" })], merges).respected, 0);
});

test("status fallback (no at): only active other-agent claims violate", () => {
  const merges = [{ agent: "A", files: ["src/auth/login.ts"] }];
  assert.equal(conformance([claim({ agent: "B", status: "active" })], merges).violations.length, 1);
  assert.equal(conformance([claim({ agent: "B", status: "released" })], merges).violations.length, 0);
  assert.equal(conformance([claim({ agent: "B", status: "expired" })], merges).violations.length, 0);
});

test("a merge record with multiple files is flattened and scored per file", () => {
  const own = claim({ id: "own", agent: "A", globs: ["src/auth/**"] });
  const other = claim({ id: "other", agent: "B", globs: ["src/pay/**"] });
  const merges = [
    { agent: "A", files: ["src/auth/login.ts", "src/pay/charge.ts", "docs/x.md"], at: INSIDE },
  ];
  const res = conformance([own, other], merges);
  assert.equal(res.total, 3);
  assert.equal(res.respected, 1); // src/auth/login.ts
  assert.equal(res.violations.length, 1); // src/pay/charge.ts under B
  assert.equal(res.warnings.length, 1); // docs/x.md unclaimed
});

test("one change under two different agents' live claims → two violations, counted once", () => {
  const b = claim({ id: "b", agent: "B" });
  const c = claim({ id: "c", agent: "C" });
  const merges = [{ agent: "A", files: ["src/auth/login.ts"], at: INSIDE }];
  const res = conformance([b, c], merges);
  assert.equal(res.total, 1);
  assert.equal(res.respected, 0);
  assert.equal(res.violations.length, 2);
});

test("score arithmetic: 3 respected, 1 violation, 1 warning over 5 → 0.6", () => {
  const own = claim({ id: "own", agent: "A", globs: ["src/**"] });
  const other = claim({ id: "other", agent: "B", globs: ["locked/**"] });
  const merges = [
    { agent: "A", files: ["src/a.ts", "src/b.ts", "src/c.ts"], at: INSIDE }, // 3 respected
    { agent: "A", files: ["locked/x.ts"], at: INSIDE }, // 1 violation
    { agent: "A", files: ["misc/y.ts"], at: INSIDE }, // 1 warning
  ];
  const res = conformance([own, other], merges);
  assert.equal(res.total, 5);
  assert.equal(res.respected, 3);
  assert.equal(res.score, 0.6);
});

test("malformed timestamps are treated as not held/active (no throw)", () => {
  const badClaimTime = claim({ created: "not-a-date" });
  const merges = [{ agent: "A", files: ["src/auth/login.ts"], at: INSIDE }];
  const res = conformance([badClaimTime], merges);
  assert.equal(res.respected, 0); // claim not held → warning
  assert.equal(res.warnings.length, 1);

  const badAt = [{ agent: "A", files: ["src/auth/login.ts"], at: "bogus" }];
  const res2 = conformance([claim()], badAt);
  assert.equal(res2.respected, 0);
  assert.equal(res2.warnings.length, 1);
});

test("globsOverlap reuse: src/auth/** covers login.ts; src/*.ts does not", () => {
  const wide = claim({ id: "w", agent: "A", globs: ["src/auth/**"] });
  assert.equal(conformance([wide], [{ agent: "A", files: ["src/auth/login.ts"], at: INSIDE }]).respected, 1);

  const shallow = claim({ id: "s", agent: "A", globs: ["src/*.ts"] });
  assert.equal(conformance([shallow], [{ agent: "A", files: ["src/auth/login.ts"], at: INSIDE }]).respected, 0);
});
