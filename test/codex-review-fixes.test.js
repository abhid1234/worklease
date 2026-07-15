// Regression tests for the Codex (Sol) review findings. Each fails against the
// pre-fix code and passes after.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveRecords, appendRecord, computeRecordId } from "../src/registry.js";
import { conformance } from "../src/conformance.js";
import { parseTtl, makeClaim } from "../src/claim.js";
import { validateClaim } from "../src/schema.js";
import { installHook } from "../src/adapters/git-hook.js";

const hash = (r) => ({ id: computeRecordId(r), ...r });
const fullClaim = (o = {}) => ({
  agent: "A", globs: ["src/**"], intent: "w", ttl_seconds: 1200,
  created: "2026-01-01T00:00:00Z", expires: "2026-01-01T00:20:00Z", status: "active", ...o,
});

// --- HIGH: released_at ends a claim in temporal reasoning --------------------
test("a claim released before a merge is not held/live at that time", () => {
  const c = { ...fullClaim(), released_at: "2026-01-01T00:10:00Z", status: "released" };
  // merge AFTER release but still inside [created, expires): must NOT be covered
  const after = conformance([c], [{ agent: "A", files: ["src/x.ts"], at: "2026-01-01T00:15:00Z" }]);
  assert.equal(after.respected, 0);
  assert.equal(after.warnings.length, 1);
  // a DIFFERENT agent editing after B released must NOT be a violation
  const cB = { ...fullClaim({ agent: "B" }), released_at: "2026-01-01T00:10:00Z", status: "released" };
  const collide = conformance([cB], [{ agent: "A", files: ["src/x.ts"], at: "2026-01-01T00:15:00Z" }]);
  assert.equal(collide.violations.length, 0);
  // before the release: still held
  const before = conformance([c], [{ agent: "A", files: ["src/x.ts"], at: "2026-01-01T00:05:00Z" }]);
  assert.equal(before.respected, 1);
});

// --- HIGH: malformed records are skipped, never reach the matcher ------------
test("resolveRecords skips a hash-valid but schema-invalid claim (no crash)", () => {
  const noGlobs = hash({ agent: "A", intent: "w", ttl_seconds: 1, created: "2026-01-01T00:00:00Z", expires: "2026-01-01T00:00:01Z", status: "active" });
  const { claims, notes } = resolveRecords([noGlobs], { now: Date.parse("2026-01-01T00:00:00Z") });
  assert.equal(claims.length, 0, "claim missing globs must be dropped");
  assert.ok(notes.some((n) => n.includes("skipped claim")));
  // and conformance over the (empty) result must not throw
  assert.doesNotThrow(() => conformance(claims, [{ agent: "A", files: ["src/x.ts"] }]));
});

test("resolveRecords skips a release missing required fields", () => {
  const c = hash(fullClaim());
  const badRelease = hash({ type: "release", claim_id: c.id }); // no agent, no at
  const { claims, notes } = resolveRecords([c, badRelease], { now: Date.parse("2026-01-01T00:00:00Z"), expire: false });
  assert.equal(claims[0].status, "active", "invalid release must not end the claim");
  assert.ok(notes.some((n) => n.includes("skipped release")));
});

// --- MEDIUM: appendRecord rejects a mismatched supplied id -------------------
test("appendRecord throws on an id that is not the content hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "wl-append-"));
  const path = join(dir, "r.jsonl");
  assert.throws(() => appendRecord(path, { id: "deadbeef", ...fullClaim() }), /does not match content hash/);
  // a correct/absent id is fine and stored as the hash
  const stored = appendRecord(path, fullClaim());
  assert.equal(stored.id, computeRecordId(fullClaim()));
});

// --- MEDIUM: parseTtl rejects unsafe integers; makeClaim stays total ---------
test("parseTtl rejects non-safe integers and overflowing durations", () => {
  assert.equal(parseTtl("999999999999999999999"), null); // > MAX_SAFE_INTEGER
  assert.equal(parseTtl(Number.MAX_SAFE_INTEGER + 1), null);
  assert.equal(parseTtl("9999999999999h"), null); // overflows on * 3600
  assert.equal(parseTtl("1800"), 1800);
  assert.equal(parseTtl("30m"), 1800);
});

test("makeClaim with an out-of-range ttl yields an invalid (not throwing) record", () => {
  let claim;
  assert.doesNotThrow(() => { claim = makeClaim(["src/**"], { agent: "A", intent: "w", ttl_seconds: Number.MAX_SAFE_INTEGER, created: "2026-01-01T00:00:00Z" }); });
  assert.equal(claim.expires, "");
  assert.equal(validateClaim(claim).valid, false); // CLI rejects it predictably
});

// --- LOW: installHook refuses a malformed managed region ---------------------
test("installHook fails safely on an orphan worklease marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "wl-hook-"));
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  const hook = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\n# >>> worklease >>>\necho orphan start, no end marker\n");
  assert.throws(() => installHook({ cwd: dir }), /malformed worklease managed region/);
  // user content is untouched by the failed install
  assert.match(readFileSync(hook, "utf8"), /orphan start/);
});
