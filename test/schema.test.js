import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateClaim,
  validateRegistry,
  isIso8601Utc,
  isAllowedGlob,
  STATUSES,
  CLAIM_FIELDS,
} from "../src/schema.js";

// A canonical fully-valid claim. created + 1800s == expires.
function validClaim(overrides = {}) {
  return {
    id: "abc123",
    agent: "agent-A",
    globs: ["src/auth/**", "config.js"],
    intent: "add OAuth",
    ttl_seconds: 1800,
    created: "2026-07-11T12:00:00Z",
    expires: "2026-07-11T12:30:00Z",
    status: "active",
    ...overrides,
  };
}

// Collect the set of error codes for a validation result.
function codes(result) {
  return result.errors.map((e) => e.code);
}
function codeAt(result, path) {
  return result.errors.filter((e) => e.path === path).map((e) => e.code);
}

test("fully-valid claim → valid, no errors", () => {
  const result = validateClaim(validClaim());
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("each required field missing → exactly one MISSING_FIELD at that path", () => {
  for (const field of CLAIM_FIELDS) {
    const claim = validClaim();
    delete claim[field];
    const result = validateClaim(claim);
    assert.equal(result.valid, false, `${field} missing should be invalid`);
    assert.deepEqual(
      codeAt(result, field),
      ["MISSING_FIELD"],
      `${field} missing should yield exactly one MISSING_FIELD at ${field}`
    );
  }
});

test("wrong types per field", () => {
  assert.deepEqual(codeAt(validateClaim(validClaim({ id: 42 })), "id"), ["WRONG_TYPE"]);
  assert.deepEqual(codeAt(validateClaim(validClaim({ agent: 1 })), "agent"), ["WRONG_TYPE"]);
  assert.deepEqual(codeAt(validateClaim(validClaim({ intent: {} })), "intent"), ["WRONG_TYPE"]);
  assert.deepEqual(codeAt(validateClaim(validClaim({ globs: "src/**" })), "globs"), ["WRONG_TYPE"]);
  assert.deepEqual(codeAt(validateClaim(validClaim({ ttl_seconds: "20" })), "ttl_seconds"), [
    "NOT_POSITIVE_INT",
  ]);
});

test("empty strings → EMPTY_STRING", () => {
  assert.deepEqual(codeAt(validateClaim(validClaim({ id: "" })), "id"), ["EMPTY_STRING"]);
  assert.deepEqual(codeAt(validateClaim(validClaim({ agent: "  " })), "agent"), ["EMPTY_STRING"]);
  assert.deepEqual(codeAt(validateClaim(validClaim({ intent: "" })), "intent"), ["EMPTY_STRING"]);
});

test("empty intent is invalid (intent is required)", () => {
  assert.equal(validateClaim(validClaim({ intent: "" })).valid, false);
  const missing = validClaim();
  delete missing.intent;
  assert.equal(validateClaim(missing).valid, false);
});

test("globs: empty array → EMPTY_ARRAY", () => {
  assert.deepEqual(codeAt(validateClaim(validClaim({ globs: [] })), "globs"), ["EMPTY_ARRAY"]);
});

test("globs: empty string element → EMPTY_STRING at globs[i]", () => {
  const result = validateClaim(validClaim({ globs: ["ok", ""] }));
  assert.deepEqual(codeAt(result, "globs[1]"), ["EMPTY_STRING"]);
});

test("globs: non-string element → WRONG_TYPE at globs[i]", () => {
  const result = validateClaim(validClaim({ globs: ["ok", 3] }));
  assert.deepEqual(codeAt(result, "globs[1]"), ["WRONG_TYPE"]);
});

test("globs: unsupported metacharacters → INVALID_GLOB", () => {
  for (const bad of ["src/**/*.ts?", "src/[abc].js", "a]b", "a{b}c", "x?y"]) {
    const result = validateClaim(validClaim({ globs: [bad] }));
    assert.deepEqual(codeAt(result, "globs[0]"), ["INVALID_GLOB"], `${bad} should be INVALID_GLOB`);
  }
});

test("globs: supported subset all pass", () => {
  const result = validateClaim(validClaim({ globs: ["**", "*", "src/auth/**", "config.js"] }));
  assert.equal(result.valid, true);
});

test("ttl_seconds must be a positive integer", () => {
  for (const t of [0, -1, 1.5, "20"]) {
    const result = validateClaim(validClaim({ ttl_seconds: t }));
    assert.deepEqual(codeAt(result, "ttl_seconds"), ["NOT_POSITIVE_INT"], `ttl=${t}`);
  }
});

test("created/expires must be ISO 8601 UTC", () => {
  // Non-ISO. Use a ttl-consistent expires so only the format error surfaces.
  assert.ok(codeAt(validateClaim(validClaim({ created: "not-a-date" })), "created").includes("INVALID_ISO8601"));
  // Missing Z (offset instead of UTC).
  assert.ok(
    codeAt(validateClaim(validClaim({ created: "2026-07-11T12:00:00+00:00" })), "created").includes(
      "INVALID_ISO8601"
    )
  );
  // Impossible calendar date passes the shape but fails Date.parse.
  assert.ok(
    codeAt(validateClaim(validClaim({ created: "2026-13-40T00:00:00Z" })), "created").includes(
      "INVALID_ISO8601"
    )
  );
  // Impossible dates that Date.parse rolls over instead of rejecting (Feb 30,
  // Apr 31) must still be caught by the round-trip check.
  assert.ok(
    codeAt(validateClaim(validClaim({ created: "2026-02-30T00:00:00Z" })), "created").includes(
      "INVALID_ISO8601"
    )
  );
  assert.ok(
    codeAt(validateClaim(validClaim({ expires: "2026-04-31T00:00:00Z" })), "expires").includes(
      "INVALID_ISO8601"
    )
  );
});

test("expires must equal created + ttl_seconds → EXPIRES_MISMATCH", () => {
  const result = validateClaim(
    validClaim({ created: "2026-07-11T12:00:00Z", ttl_seconds: 1800, expires: "2026-07-11T13:00:00Z" })
  );
  assert.deepEqual(codeAt(result, "expires"), ["EXPIRES_MISMATCH"]);
});

test("exact expires match passes, including sub-second created", () => {
  const result = validateClaim(
    validClaim({
      created: "2026-07-11T12:00:00.500Z",
      ttl_seconds: 60,
      expires: "2026-07-11T12:01:00.500Z",
    })
  );
  assert.equal(result.valid, true);
});

test("mismatch is not piled onto a format error", () => {
  // created invalid → we should get INVALID_ISO8601 but NOT EXPIRES_MISMATCH.
  const result = validateClaim(validClaim({ created: "nope" }));
  assert.ok(codes(result).includes("INVALID_ISO8601"));
  assert.ok(!codes(result).includes("EXPIRES_MISMATCH"));
});

test("status must be a valid enum", () => {
  assert.deepEqual(codeAt(validateClaim(validClaim({ status: "done" })), "status"), ["INVALID_ENUM"]);
  for (const s of STATUSES) {
    assert.equal(validateClaim(validClaim({ status: s })).valid, true, `status ${s} should be valid`);
  }
});

test("unknown top-level field → UNKNOWN_FIELD at that key", () => {
  const result = validateClaim(validClaim({ foo: "bar" }));
  assert.deepEqual(codeAt(result, "foo"), ["UNKNOWN_FIELD"]);
});

test("non-object input → single NOT_OBJECT", () => {
  for (const bad of [null, [], 42, "x", undefined]) {
    const result = validateClaim(bad);
    assert.deepEqual(result.errors.map((e) => e.code), ["NOT_OBJECT"]);
    assert.deepEqual(result.errors[0].path, "");
  }
});

test("multiple simultaneous violations are all reported", () => {
  const result = validateClaim({
    id: "",
    agent: "a",
    globs: [],
    intent: "",
    ttl_seconds: -1,
    created: "bad",
    expires: "bad",
    status: "nope",
    extra: 1,
  });
  const c = codes(result);
  assert.ok(c.includes("EMPTY_STRING")); // id / intent
  assert.ok(c.includes("EMPTY_ARRAY")); // globs
  assert.ok(c.includes("NOT_POSITIVE_INT")); // ttl_seconds
  assert.ok(c.includes("INVALID_ISO8601")); // created / expires
  assert.ok(c.includes("INVALID_ENUM")); // status
  assert.ok(c.includes("UNKNOWN_FIELD")); // extra
  assert.ok(result.errors.length >= 6);
});

// ---- helpers ----

test("isIso8601Utc", () => {
  assert.equal(isIso8601Utc("2026-07-11T12:00:00Z"), true);
  assert.equal(isIso8601Utc("2026-07-11T12:00:00.123Z"), true);
  assert.equal(isIso8601Utc("2026-07-11T12:00:00+00:00"), false);
  assert.equal(isIso8601Utc("2026-13-40T00:00:00Z"), false);
  // Impossible calendar dates that Date.parse silently rolls over (must not
  // be accepted): Feb has no 30th, April no 31st.
  assert.equal(isIso8601Utc("2026-02-30T00:00:00Z"), false);
  assert.equal(isIso8601Utc("2026-04-31T00:00:00Z"), false);
  assert.equal(isIso8601Utc("2026-07-11 12:00:00Z"), false);
  assert.equal(isIso8601Utc(42), false);
});

test("isAllowedGlob", () => {
  assert.equal(isAllowedGlob("src/auth/**"), true);
  assert.equal(isAllowedGlob("*"), true);
  assert.equal(isAllowedGlob("**"), true);
  assert.equal(isAllowedGlob("config.js"), true);
  assert.equal(isAllowedGlob(""), false);
  assert.equal(isAllowedGlob("a?b"), false);
  assert.equal(isAllowedGlob("a[b]"), false);
  assert.equal(isAllowedGlob("a{b}"), false);
});

// ---- validateRegistry ----

test("valid array of unique-id claims → valid", () => {
  const reg = [validClaim({ id: "one" }), validClaim({ id: "two" })];
  assert.deepEqual(validateRegistry(reg), { valid: true, errors: [] });
});

test("empty array is a valid registry", () => {
  assert.deepEqual(validateRegistry([]), { valid: true, errors: [] });
});

test("non-array input → single NOT_ARRAY", () => {
  for (const bad of [null, {}, 42, "x"]) {
    const result = validateRegistry(bad);
    assert.deepEqual(result.errors.map((e) => e.code), ["NOT_ARRAY"]);
  }
});

test("element error path is prefixed with [i]", () => {
  const reg = [validClaim({ id: "one" }), validClaim({ id: "two", globs: [""] })];
  const result = validateRegistry(reg);
  assert.deepEqual(codeAt(result, "[1].globs[0]"), ["EMPTY_STRING"]);
});

test("whole-element NOT_OBJECT path is [i]", () => {
  const result = validateRegistry([validClaim(), 42]);
  assert.deepEqual(codeAt(result, "[1]"), ["NOT_OBJECT"]);
});

test("duplicate id across elements → DUPLICATE_ID at the later occurrence", () => {
  const reg = [validClaim({ id: "dup" }), validClaim({ id: "dup" })];
  const result = validateRegistry(reg);
  assert.deepEqual(codeAt(result, "[1].id"), ["DUPLICATE_ID"]);
  assert.equal(codeAt(result, "[0].id").length, 0);
});
