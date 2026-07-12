import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClaim, parseTtl } from "../src/claim.js";
import { validateClaim, CLAIM_FIELDS } from "../src/schema.js";

const META = {
  agent: "agent-A",
  intent: "add OAuth",
  ttl_seconds: 1800,
  created: "2026-07-11T12:00:00Z",
};

// --- makeClaim -------------------------------------------------------------

test("built claim passes validateClaim (round-trip with #1)", () => {
  const claim = makeClaim(["src/auth/**"], META);
  const { valid, errors } = validateClaim(claim);
  assert.equal(valid, true, JSON.stringify(errors));
});

test("field set and order match CLAIM_FIELDS", () => {
  const claim = makeClaim(["src/auth/**"], META);
  assert.deepEqual(Object.keys(claim), CLAIM_FIELDS);
});

test("status is always active on creation", () => {
  assert.equal(makeClaim(["a/**"], META).status, "active");
});

test("expires === created + ttl_seconds (epoch-ms equality) for several ttls", () => {
  for (const ttl_seconds of [1, 90, 1200, 1800, 7200]) {
    const claim = makeClaim(["src/**"], { ...META, ttl_seconds });
    assert.equal(
      Date.parse(claim.expires),
      Date.parse(claim.created) + ttl_seconds * 1000,
      `ttl=${ttl_seconds}`
    );
  }
});

test("globs are carried through unchanged, in order", () => {
  const globs = ["src/b/**", "src/a/**", "config.js"];
  assert.deepEqual(makeClaim(globs, META).globs, globs);
});

// --- id stability & sensitivity -------------------------------------------

test("id-stability: same inputs → same id across calls", () => {
  const a = makeClaim(["src/auth/**"], META);
  const b = makeClaim(["src/auth/**"], META);
  assert.equal(a.id, b.id);
  assert.match(a.id, /^[0-9a-f]{64}$/);
});

test("id-sensitivity: changing each hashed field changes the id", () => {
  const base = makeClaim(["src/auth/**"], META).id;
  assert.notEqual(makeClaim(["src/auth/**"], { ...META, agent: "agent-B" }).id, base);
  assert.notEqual(makeClaim(["src/api/**"], META).id, base);
  assert.notEqual(makeClaim(["src/auth/**"], { ...META, intent: "other" }).id, base);
  assert.notEqual(makeClaim(["src/auth/**"], { ...META, ttl_seconds: 900 }).id, base);
  assert.notEqual(
    makeClaim(["src/auth/**"], { ...META, created: "2026-07-11T12:00:01Z" }).id,
    base
  );
});

test("glob order is part of the id (order-sensitive)", () => {
  const a = makeClaim(["a/**", "b/**"], META).id;
  const b = makeClaim(["b/**", "a/**"], META).id;
  assert.notEqual(a, b);
});

test("two claims filed at different times get different ids", () => {
  const a = makeClaim(["src/**"], { ...META, created: "2026-07-11T12:00:00Z" });
  const b = makeClaim(["src/**"], { ...META, created: "2026-07-11T12:05:00Z" });
  assert.notEqual(a.id, b.id);
});

// --- parseTtl --------------------------------------------------------------

test("parseTtl accepts shorthand and bare seconds", () => {
  assert.equal(parseTtl("20m"), 1200);
  assert.equal(parseTtl("2h"), 7200);
  assert.equal(parseTtl("90s"), 90);
  assert.equal(parseTtl("1800"), 1800);
  assert.equal(parseTtl(1800), 1800);
  assert.equal(parseTtl("1"), 1);
});

test("parseTtl rejects invalid input with null", () => {
  for (const bad of ["0", "0m", "-5m", "1.5m", "20x", "", "m", "abc", "1d", 0, -1, 1.5, null]) {
    assert.equal(parseTtl(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});
